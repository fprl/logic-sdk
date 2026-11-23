import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text } from "drizzle-orm/pg-core";
import { beforeEach, expect, setSystemTime, test } from "bun:test";
import { z } from "zod";
import { cronRunsTable, databaseQueue, drizzleAdapter, jobsSchema, jobsTable, outbox, type DrizzleTx } from "../src/drizzle/pg.ts";
import { init, type Delivery, type JobsAdapter, type FailureInfo } from "../src/index.ts";

// The real Postgres engine, in process, with the schema we ship.
const pg = new PGlite();
await pg.exec(`
  ${jobsSchema}
  CREATE TABLE items (name text PRIMARY KEY);
`);
const db = drizzle({ client: pg });
const database = drizzleAdapter(db);
const items = pgTable("items", { name: text("name").primaryKey() });

type Scope = { actor: string };
const { mutation, action, event, listener, cron, createRegistry } = init<{ scope: Scope; db: DrizzleTx<typeof db> }>();

const added = event({ payload: z.object({ name: z.string() }) });
const add = mutation({
  input: z.object({ name: z.string() }),
  async handler(ctx, { name }) {
    await ctx.db.insert(items).values({ name });
    ctx.emit(added, { name });
    if (name === "rolled-back") throw ctx.errors.reject("no");
  },
});
/** What the listener does next: run, throw, say no, or lose its lease mid-run. */
let next: "ok" | "throw" | "deny" | "lose-lease" = "ok";
const ran: string[] = [];
const react = listener({
  event: () => added,
  attempts: 2,
  async handler(ctx, { name }) {
    ran.push(`${name}#${ctx.event.attempt}`);
    if (next === "throw") throw new Error("smtp down");
    if (next === "deny") throw ctx.errors.reject("nope");
    if (next === "lose-lease") await db.update(jobsTable).set({ attempts: sql`${jobsTable.attempts} + 1`, receipt: "a sweep's" }); // a sweep took it over
  },
});

const rows = () => db.select().from(jobsTable);
const makeDue = () => db.update(jobsTable).set({ availableAt: sql`now() - interval '1 second'` });
function setup(jobs: JobsAdapter = databaseQueue(database)) {
  const registry = createRegistry({ modules: { x: { added, add, react } }, database, jobs: { adapter: jobs, scope: { load: (saved) => saved } }, onError: () => {} });
  return { registry, app: registry.as({ actor: "ana" }) };
}

beforeEach(async () => {
  await pg.exec("TRUNCATE logic_jobs, logic_cron_runs, items");
  next = "ok";
  ran.length = 0;
});

test("a committed event is delivered and its row deleted; a rolled-back one never existed", async () => {
  const { app } = setup();
  await app.run(add, { name: "desk" });
  expect(ran).toEqual(["desk#1"]);
  expect(await rows()).toEqual([]);
  await expect(app.run(add, { name: "rolled-back" })).rejects.toMatchObject({ kind: "rejected" });
  expect(await rows()).toEqual([]);
});

test("a failure keeps the row with a backoff and the error; a sweep after the backoff delivers it", async () => {
  const { app, registry } = setup();
  next = "throw";
  await app.run(add, { name: "lamp" });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: expect.stringContaining("smtp down") });
  expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now()); // e^1 seconds from now
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 }); // not due yet
  next = "ok";
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["lamp#1", "lamp#2"]);
  expect(await rows()).toEqual([]);
});

test("out of attempts it's failed; retry puts it back in line, and only failed rows", async () => {
  const { app, registry } = setup();
  next = "throw";
  await app.run(add, { name: "chair" });
  const [pending] = await rows();
  expect(await registry.jobs.retry(pending!.id)).toBe(false); // pending: its runner or a sweep owns it, so retry leaves it alone
  expect(await rows()).toMatchObject([{ status: "pending", attempts: 1 }]);
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "failed", attempts: 2 });
  next = "ok";
  expect(await registry.jobs.retry(row!.id)).toBe(true);
  expect(await registry.jobs.retry("x.react@nope")).toBe(false);
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["chair#1", "chair#2", "chair#1"]);
});

test("a rule saying no is failed at once, no retries", async () => {
  const { app } = setup();
  next = "deny";
  await app.run(add, { name: "sofa" });
  expect(await rows()).toMatchObject([{ status: "failed", attempts: 1 }]);
});

test("a runner that crashed after commit: a sweep takes over once its pickup time is over", async () => {
  const { app, registry } = setup({ ...databaseQueue(database), deliver: async () => {} }); // committed, then the process died
  await app.run(add, { name: "rug" });
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 }); // still its request's to run
  const [row] = await rows(); // the row is the job: what was enqueued is what runs
  expect(row!.job).toMatchObject({ id: row!.id, listener: "x.react", envelope: { name: "x.added", payload: { name: "rug" }, depth: 1 } });
  await makeDue(); // the pickup time is over
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["rug#1"]); // never started, so this is its first try
});

test("a slow runner can't undo a newer claim: completion writes are fenced on the receipt", async () => {
  const { app } = setup();
  next = "lose-lease";
  await app.run(add, { name: "vase" });
  expect(await rows()).toMatchObject([{ status: "pending", attempts: 2 }]); // the newer runner still owns it
});

test("a job whose scope can't be loaded is discarded: its row is deleted and the sweep counts it", async () => {
  let gone = false;
  const registry = createRegistry({
    modules: { x: { added, add, react } },
    database,
    onError: () => {},
    jobs: { adapter: databaseQueue(database), scope: { load: (s) => (gone ? null : s) } },
  });
  next = "throw";
  await registry.as({ actor: "ana" }).run(add, { name: "lamp" }); // first try fails: the row waits for a retry
  gone = true; // the account was offboarded meanwhile
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 1, retrying: 0 });
  expect(await rows()).toEqual([]);
  expect(ran).toEqual(["lamp#1"]);
});

/** A queue that records what it got (and in how many sends), or fails while `down`. */
const fakeVia = () => {
  const got: string[] = [];
  const via = { down: false, got, sends: 0, async deliver(jobs: Delivery[]) {
    if (via.down) throw new Error("queue unavailable");
    via.sends++;
    got.push(...jobs.map((j) => j.id));
  } };
  return via;
};

test("outbox: the row makes the handoff durable; once the queue has it, the row is gone and nothing runs here", async () => {
  const via = fakeVia();
  const { app } = setup(outbox(database, via));
  await app.run(add, { name: "desk" });
  expect(via.got).toHaveLength(1);
  expect(ran).toEqual([]); // the consumer runs it, not this request
  expect(await rows()).toEqual([]);
});

test("outbox: a failed handoff keeps the row, reaches onError, and the sweep sends it again; out of attempts it's failed", async () => {
  const via = fakeVia();
  const reported: FailureInfo[] = [];
  const registry = createRegistry({
    modules: { x: { added, add, react } },
    database,
    onError: (_e, info) => reported.push(info),
    jobs: { adapter: outbox(database, via, { maxAttempts: 2 }), scope: { load: (saved) => saved } }, // two failed sends, then failed
  });
  via.down = true;
  await registry.as({ actor: "ana" }).run(add, { name: "lamp" });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: expect.stringContaining("queue unavailable") });
  expect(reported).toEqual([expect.objectContaining({ source: "x.react", job: expect.objectContaining({ id: row!.id }), attempt: 1 })]);
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 }); // second handoff fails too
  via.down = false;
  expect(await registry.jobs.retry(row!.id)).toBe(true);
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 }); // done: handed off
  expect(via.got).toEqual([row!.id]);
  expect(await rows()).toEqual([]);
});

test("a last try that never finished is failed on the next sweep, without running again", async () => {
  const { app, registry } = setup({ ...databaseQueue(database), deliver: async () => {} }); // committed, then the process died
  await app.run(add, { name: "rug" });
  await db.update(jobsTable).set({ attempts: 2 }); // it died on its second and last try too
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 });
  expect(ran).toEqual([]);
  expect(await rows()).toMatchObject([{ status: "failed", attempts: 3 }]);
});

test("delay: the row waits unclaimed until it's due, then a sweep runs it", async () => {
  const later = listener({ event: () => added, delay: 60, async handler(_ctx, { name }) { ran.push(`later ${name}`); } });
  const registry = createRegistry({ modules: { x: { added, add, react, later } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } }, onError: () => {} });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(ran).toEqual(["desk#1"]); // react ran; later waits
  const [row] = await rows();
  expect(row).toMatchObject({ id: expect.stringMatching(/^x\.later@/), status: "pending", attempts: 0 });
  expect(row!.availableAt.getTime() - Date.now()).toBeGreaterThan(55_000);
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 });
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["desk#1", "later desk"]);
});

test("outbox: the jobs of one commit go in one send", async () => {
  const also = listener({ event: () => added, async handler() {} });
  const via = fakeVia();
  const registry = createRegistry({ modules: { x: { added, add, react, also } }, database, jobs: { adapter: outbox(database, via), scope: { load: (saved) => saved } } });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(via.sends).toBe(1);
  expect(via.got).toHaveLength(2);
  expect(await rows()).toEqual([]);
});

test("outbox: a job that fails for good in the consumer comes back as a failed row, even if the handoff's delete lands after", async () => {
  let consumer: ReturnType<typeof setup>["registry"] | undefined;
  const via = { async deliver(jobs: Delivery[]) {
    for (const job of jobs) await consumer!.jobs.run(job, { attempt: 2 }); // the queue ran it before this request deleted the row
  } };
  const { app, registry } = setup(outbox(database, via));
  consumer = registry;
  next = "throw";
  await app.run(add, { name: "lamp" });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "failed", lastError: expect.stringContaining("smtp down") });
  next = "ok";
  expect(await registry.jobs.retry(row!.id)).toBe(true);
});

test("databaseQueue(database) must share the registry's database: it writes in the mutation's transaction", () => {
  const other = drizzleAdapter(drizzle({ client: pg }));
  expect(() => createRegistry({ modules: {}, database, jobs: { adapter: databaseQueue(other), scope: { load: (saved) => saved } } })).toThrow(/must use the same database as `database`/);
});

test("out of tries, a job whose code is missing is failed with why, and retry runs it once the code is back", async () => {
  const { registry } = setup();
  const envelope = { id: "e", name: "x.added", payload: { name: "gone" }, scope: { actor: "ana" }, occurredAt: "", depth: 1 };
  await db.insert(jobsTable).values({ id: "x.react@e", job: { kind: "delivery", id: "x.react@e", listener: "x.removed", envelope, attempts: 1 } });
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 });
  expect(await rows()).toMatchObject([{ status: "failed", lastError: expect.stringMatching(/x\.removed isn't a registered listener/) }]);
  // the code is back (here: the row points at a listener that exists)
  await db.update(jobsTable).set({ job: { kind: "delivery", id: "x.react@e", listener: "x.react", envelope, attempts: 1 } });
  expect(await registry.jobs.retry("x.react@e")).toBe(true);
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["gone#1"]);
});

test("a rolling deploy: the old server puts a job it has no code for back, and the new one runs it", async () => {
  const server = (mods: Record<string, object>) =>
    createRegistry({ modules: mods, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } }, onError: () => {} });
  const oldServer = server({ x: { added, add } });
  const newServer = server({ x: { added, add, react } });
  const envelope = { id: "e", name: "x.added", payload: { name: "desk" }, scope: { actor: "ana" }, occurredAt: "", depth: 1 };
  await db.insert(jobsTable).values({ id: "x.react@e", job: { kind: "delivery", id: "x.react@e", listener: "x.react", envelope, attempts: 2 } });

  expect(await oldServer.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 1 });
  expect(await rows()).toMatchObject([{ status: "pending", lastError: expect.stringMatching(/x\.react isn't a registered listener/) }]);
  await makeDue();
  expect(await newServer.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["desk#2"]);
});

test("a listener's attempts decide its tries, however many", async () => {
  const stubborn = listener({ event: () => added, attempts: 4, async handler() { ran.push("stubborn"); throw new Error("still down"); } });
  const registry = createRegistry({ modules: { x: { added, add, stubborn } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } }, onError: () => {} });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  for (let i = 0; i < 3; i++) {
    await makeDue();
    await registry.jobs.sweep();
  }
  expect(ran).toEqual(["stubborn", "stubborn", "stubborn", "stubborn"]);
  expect(await rows()).toMatchObject([{ status: "failed", attempts: 4 }]);
});

test("a crash between commit and the first try: the sweep's claim is the first try, so a one-try listener still runs", async () => {
  const once = listener({ event: () => added, async handler(_ctx, { name }) { ran.push(`once ${name}`); } });
  const died = { ...databaseQueue(database), deliver: async () => {} }; // committed, then the process died before delivering
  const registry = createRegistry({ modules: { x: { added, add, once } }, database, jobs: { adapter: died, scope: { load: (saved) => saved } }, onError: () => {} });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(await rows()).toMatchObject([{ status: "pending", attempts: 0 }]);
  await makeDue(); // the pickup time is over
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["once desk"]);
});

test("sweep({ limit }) claims at most that many", async () => {
  const { app, registry } = setup({ ...databaseQueue(database), deliver: async () => {} });
  await app.run(add, { name: "a" });
  await app.run(add, { name: "b" });
  await makeDue();
  expect(await registry.jobs.sweep({ limit: 1 })).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(await rows()).toHaveLength(1);
});

test("crons: several servers ticking the same minute run each cron once, and old runs are pruned", async () => {
  const tidy = mutation({ async handler(ctx) { await ctx.db.insert(items).values({ name: `tidied ${ran.length}` }); ran.push("tidy"); } });
  const nightly = cron({ schedule: "0 3 * * *", run: tidy, scope: { actor: "system" } });
  const make = () => createRegistry({ modules: { x: { tidy, nightly } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });
  await db.insert(cronRunsTable).values({ id: "x.nightly@old", ranAt: new Date("2026-01-01T00:00:00Z") });

  const at = new Date("2026-11-23T03:00:00Z");
  await Promise.all([make().jobs.tick(at), make().jobs.tick(at), make().jobs.tick(at)]);
  await make().jobs.tick(at); // a trigger delivered again, later
  expect(ran).toEqual(["tidy"]);
  expect(await db.select({ id: cronRunsTable.id }).from(cronRunsTable)).toEqual([{ id: "x.nightly@20261123T0300Z" }]);
  expect(await rows()).toEqual([]); // ran and deleted
});

test("ctx.schedule: the row waits, unclaimed, until it's due; then a sweep runs it", async () => {
  const remind = action({ input: z.object({ who: z.string() }), async handler(_ctx, { who }) { ran.push(`remind ${who}`); } });
  const book = mutation({ async handler(ctx) { ctx.schedule(remind, { who: "guest" }, { delay: 3600 }); } });
  const registry = createRegistry({ modules: { x: { remind, book } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } }, onError: () => {} });
  await registry.as({ actor: "ana" }).run(book);
  const [row] = await rows();
  expect(row).toMatchObject({ id: expect.stringMatching(/^x\.remind@/), status: "pending", attempts: 0, job: { kind: "call", fn: "x.remind", attempts: 1, depth: 0 } });
  expect(row!.availableAt.getTime() - Date.now()).toBeGreaterThan(3500_000);
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 });
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["remind guest"]);
});

test("ctx.schedule replace: the waiting call with the key becomes the new one; one that started isn't touched", async () => {
  const remind = action({ input: z.object({ at: z.string() }), async handler(_ctx, { at }) { ran.push(`remind for ${at}`); } });
  const book = mutation({
    input: z.object({ booking: z.string(), checkIn: z.string(), delay: z.number() }),
    async handler(ctx, { booking, checkIn, delay }) {
      return ctx.schedule(remind, { at: checkIn }, { delay, replace: booking });
    },
  });
  const registry = createRegistry({ modules: { x: { remind, book } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });
  const app = registry.as({ actor: "ana" });
  await app.run(book, { booking: "b1", checkIn: "July 3", delay: 3600 });
  const moved = await app.run(book, { booking: "b1", checkIn: "July 9", delay: 7200 }); // the dates changed
  await app.run(book, { booking: "b2", checkIn: "July 5", delay: 3600 }); // another booking keeps its own
  const waiting = (await rows()).sort((a, b) => String(a.replaceKey).localeCompare(String(b.replaceKey)));
  expect(waiting.map((r) => [r.replaceKey, (r.job as { input: unknown }).input])).toEqual([
    ["x.remind@b1", { at: "July 9" }],
    ["x.remind@b2", { at: "July 5" }],
  ]);
  expect(waiting[0]!.id).toBe(moved); // the id ctx.schedule returned
  expect(waiting[0]!.availableAt.getTime() - Date.now()).toBeGreaterThan(7000_000);

  await db.update(jobsTable).set({ attempts: 1 }); // claimed: both have started
  await app.run(book, { booking: "b1", checkIn: "July 10", delay: 0 }); // so this one runs on its own
  expect(ran).toEqual(["remind for July 10"]);
  expect((await rows()).filter((r) => r.replaceKey === "x.remind@b1")).toHaveLength(1); // the started one stays
});

test("ctx.schedule replace: only adapters that can replace take it", async () => {
  const remind = action({ async handler() {} });
  const book = mutation({ async handler(ctx) { ctx.schedule(remind, undefined, { delay: 60, replace: "b1" }); } });
  const sent = createRegistry({
    modules: { x: { remind, book } },
    database,
    jobs: { adapter: { holds: true, async deliver() {} }, scope: { load: (saved) => saved } },
  });
  await expect(sent.as({ actor: "ana" }).run(book)).rejects.toThrow(/replaces a waiting call, but your jobs adapter can't replace one it already has\. Use databaseQueue\(database\)/);
});

test("ctx.schedule replace: due now, it takes over the waiting row and runs once, under the new id", async () => {
  const remind = action({ input: z.object({ at: z.string() }), async handler(_ctx, { at }) { ran.push(`remind for ${at}`); } });
  const book = mutation({
    input: z.object({ at: z.string(), delay: z.number(), twice: z.boolean().optional() }),
    async handler(ctx, { at, delay, twice }) {
      if (twice) ctx.schedule(remind, { at: "draft" }, { delay, replace: "b1" }); // one statement can't upsert a key twice: the core keeps the later
      return ctx.schedule(remind, { at }, { delay, replace: "b1" });
    },
  });
  const registry = createRegistry({ modules: { x: { remind, book } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });
  const app = registry.as({ actor: "ana" });
  await app.run(book, { at: "July 3", delay: 3600, twice: true });
  expect((await rows()).map((r) => (r.job as { input: unknown }).input)).toEqual([{ at: "July 3" }]);
  await app.run(book, { at: "now", delay: 0 });
  expect(ran).toEqual(["remind for now"]);
  expect(await rows()).toEqual([]); // the waiting one was replaced, then ran and was deleted
});

test("retry of a failed call drops its key, so it doesn't collide with the one waiting in its place", async () => {
  const remind = action({ input: z.object({ fail: z.boolean() }), async handler(ctx, { fail }) { if (fail) throw ctx.errors.reject("no"); } });
  const book = mutation({
    input: z.object({ fail: z.boolean(), delay: z.number() }),
    async handler(ctx, { fail, delay }) { return ctx.schedule(remind, { fail }, { delay, replace: "b1" }); },
  });
  const registry = createRegistry({ modules: { x: { remind, book } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } }, onError: () => {} });
  const app = registry.as({ actor: "ana" });
  const failed = await app.run(book, { fail: true, delay: 0 }); // runs now and fails for good: kept
  await app.run(book, { fail: false, delay: 3600 }); // the booking moved: a new one waits with the key
  expect(await registry.jobs.retry(failed)).toBe(true);
  const byId = Object.fromEntries((await rows()).map((r) => [r.id, [r.status, r.replaceKey]]));
  expect(byId[failed]).toEqual(["pending", null]); // back in line, no longer replaceable
  expect(Object.values(byId)).toContainEqual(["pending", "x.remind@b1"]); // the one waiting kept its key
});

test("a commit's jobs are claimed one at a time: while one runs, the next hasn't spent its attempt", async () => {
  let whileFirstRan: number[] = [];
  const first = listener({ event: () => added, async handler() { whileFirstRan = (await rows()).map((r) => r.attempts).sort(); } });
  const second = listener({ event: () => added, async handler() { ran.push("second"); } });
  const registry = createRegistry({ modules: { x: { added, add, first, second } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(whileFirstRan).toEqual([0, 1]);
  expect(ran).toEqual(["second"]);
  expect(await rows()).toEqual([]);
});

test("a slow first job doesn't fail the next: a sweep runs that one meanwhile, as its first try", async () => {
  let swept: unknown;
  const first = listener({
    event: () => added,
    async handler() {
      await db.update(jobsTable).set({ availableAt: sql`now() - interval '1 second'` }).where(sql`attempts = 0`); // past its pickup time
      swept = await registry.jobs.sweep();
    },
  });
  const second = listener({ event: () => added, async handler(ctx) { ran.push(`second#${ctx.event.attempt}`); } });
  const registry = createRegistry({ modules: { x: { added, add, first, second } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(swept).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["second#1"]);
  expect(await rows()).toEqual([]);
});

for (const when of ["waiting to run", "running again"] as const)
  test(`after retry(id), the runner that lost the job can't finish it while it's ${when}`, async () => {
    const once = listener({
      event: () => added,
      async handler() {
        const [row] = await rows();
        await db.update(jobsTable).set({ status: "failed" }); // its lease ran out and a sweep failed it
        await registry.jobs.retry(row!.id);
        if (when === "running again") await db.update(jobsTable).set({ attempts: 1, receipt: "the new run's" }); // the same attempt number again
      },
    });
    const registry = createRegistry({ modules: { x: { added, add, once } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });
    await registry.as({ actor: "ana" }).run(add, { name: "desk" }); // the first run returns, done
    expect(await rows()).toMatchObject([{ status: "pending" }]);
  });

test("a crash right after commit waits for the pickup time, not a whole lease", async () => {
  const { app } = setup({ ...databaseQueue(database), deliver: async () => {} });
  await app.run(add, { name: "rug" });
  const wait = (await rows())[0]!.availableAt.getTime() - Date.now();
  expect(wait).toBeGreaterThan(25_000);
  expect(wait).toBeLessThan(35_000);
});

test("a failed row says when, and where it threw; retry clears both", async () => {
  const { app, registry } = setup();
  next = "deny";
  await app.run(add, { name: "sofa" });
  const [row] = await rows();
  expect(row!.failedAt).toBeInstanceOf(Date);
  expect(row!.lastError).toMatch(/\n\s+at /); // the stack
  expect(await registry.jobs.retry(row!.id)).toBe(true);
  expect(await rows()).toMatchObject([{ failedAt: null, lastError: null }]);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a job slower than its lease stays its runner's: the lease extends while it runs", async () => {
  let swept: unknown;
  const slow = listener({
    event: () => added,
    async handler() {
      await sleep(900); // twice the lease
      swept = await registry.jobs.sweep();
      ran.push("slow");
    },
  });
  const registry = createRegistry({ modules: { x: { added, add, slow } }, database, jobs: { adapter: databaseQueue(database, { lease: 0.45 }), scope: { load: (saved) => saved } } });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(swept).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 }); // nothing was free to take
  expect(ran).toEqual(["slow"]);
  expect(await rows()).toEqual([]); // and it finished as a success
});

test("extending stops after 15 minutes, so a hung job is taken over in the end", async () => {
  const before: string[] = [];
  const hung = listener({
    event: () => added,
    async handler() {
      setSystemTime(new Date(Date.now() + 16 * 60_000));
      await sleep(100); // an extension already on its way lands
      before.push((await rows())[0]!.availableAt.toISOString());
      await sleep(250); // a few more turns of the timer
      before.push((await rows())[0]!.availableAt.toISOString());
    },
  });
  const registry = createRegistry({ modules: { x: { added, add, hung } }, database, jobs: { adapter: databaseQueue(database, { lease: 0.15 }), scope: { load: (saved) => saved } } });
  try {
    await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  } finally {
    setSystemTime();
  }
  expect(before).toHaveLength(2);
  expect(before[1]).toBe(before[0]!);
});

test("a retry's backoff stands: no extension lands after it", async () => {
  const flaky = listener({ event: () => added, attempts: 2, async handler() { await sleep(120); throw new Error("down"); } });
  const registry = createRegistry({ modules: { x: { added, add, flaky } }, database, jobs: { adapter: databaseQueue(database, { lease: 0.15, backoff: () => 600 }), scope: { load: (saved) => saved } }, onError: () => {} });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  await sleep(120);
  expect((await rows())[0]!.availableAt.getTime() - Date.now()).toBeGreaterThan(590_000);
});
