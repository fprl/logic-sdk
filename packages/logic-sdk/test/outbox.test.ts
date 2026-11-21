import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text } from "drizzle-orm/pg-core";
import { beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { cronRunsTable, drizzleAdapter, outbox, outboxTable, type DrizzleTx } from "../src/drizzle.ts";
import { init, type Delivery, type Dispatcher, type FailureInfo } from "../src/index.ts";

// The real Postgres engine, in process. The DDL is what drizzle-kit generates from outboxTable.
const pg = new PGlite();
await pg.exec(`
  CREATE TABLE logic_outbox (
    id text PRIMARY KEY, delivery jsonb NOT NULL, status text DEFAULT 'pending' NOT NULL,
    attempts integer DEFAULT 0 NOT NULL, available_at timestamptz DEFAULT now() NOT NULL,
    last_error text, created_at timestamptz DEFAULT now() NOT NULL
  );
  CREATE INDEX logic_outbox_due ON logic_outbox (available_at) WHERE status = 'pending';
  CREATE TABLE logic_cron_runs (id text PRIMARY KEY, ran_at timestamptz DEFAULT now() NOT NULL);
  CREATE TABLE items (name text PRIMARY KEY);
`);
const db = drizzle({ client: pg });
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
    if (next === "lose-lease") await db.update(outboxTable).set({ attempts: sql`${outboxTable.attempts} + 1` }); // a sweep took it over
  },
});

const rows = () => db.select().from(outboxTable);
const makeDue = () => db.update(outboxTable).set({ availableAt: sql`now() - interval '1 second'` });
function setup(jobs: Dispatcher = outbox(db)) {
  const registry = createRegistry({ modules: { x: { added, add, react } }, database: drizzleAdapter(db), jobs: { adapter: jobs }, onError: () => {} });
  return { registry, app: registry.as({ actor: "ana" }) };
}

beforeEach(async () => {
  await pg.exec("TRUNCATE logic_outbox, logic_cron_runs, items");
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
  const { app, registry } = setup(outbox(db, { maxAttempts: 3 }));
  next = "throw";
  await app.run(add, { name: "lamp" });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "smtp down" });
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

test("a runner that crashed after commit: its lease expires and a sweep takes over", async () => {
  const { app, registry } = setup({ ...outbox(db), deliver: async () => {} }); // committed, then the process died
  await app.run(add, { name: "rug" });
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 }); // still leased
  const [row] = await rows(); // the row is the job: what was enqueued is what runs
  expect(row!.delivery).toMatchObject({ id: row!.id, listener: "x.react", envelope: { name: "x.added", payload: { name: "rug" }, depth: 1 } });
  await makeDue(); // the lease ran out
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["rug#1"]); // never started, so this is its first try
});

test("a slow runner can't undo a newer claim: completion writes are fenced on attempts", async () => {
  const { app } = setup();
  next = "lose-lease";
  await app.run(add, { name: "vase" });
  expect(await rows()).toMatchObject([{ status: "pending", attempts: 2 }]); // the newer runner still owns it
});

test("a job whose scope can't be loaded is discarded: its row is deleted and the sweep counts it", async () => {
  let gone = false;
  const registry = createRegistry({
    modules: { x: { added, add, react } },
    database: drizzleAdapter(db),
    onError: () => {},
    jobs: { adapter: outbox(db), scope: { load: (s) => (gone ? null : s) } },
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

test("via: the row makes the handoff durable; once the queue has it, the row is gone and nothing runs here", async () => {
  const via = fakeVia();
  const { app } = setup(outbox(db, { via }));
  await app.run(add, { name: "desk" });
  expect(via.got).toHaveLength(1);
  expect(ran).toEqual([]); // the consumer runs it, not this request
  expect(await rows()).toEqual([]);
});

test("via: a failed handoff keeps the row, reaches onError, and the sweep sends it again; out of attempts it's failed", async () => {
  const via = fakeVia();
  const reported: FailureInfo[] = [];
  const registry = createRegistry({
    modules: { x: { added, add, react } },
    database: drizzleAdapter(db),
    onError: (_e, info) => reported.push(info),
    jobs: { adapter: outbox(db, { via, maxAttempts: 2 }) }, // two failed sends, then failed
  });
  via.down = true;
  await registry.as({ actor: "ana" }).run(add, { name: "lamp" });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "queue unavailable" });
  expect(reported).toEqual([expect.objectContaining({ listener: "x.react", delivery: row!.id, attempt: 1 })]);
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 }); // second handoff fails too
  via.down = false;
  expect(await registry.jobs.retry(row!.id)).toBe(true);
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 }); // done: handed off
  expect(via.got).toEqual([row!.id]);
  expect(await rows()).toEqual([]);
});

test("a last try that never finished is failed on the next sweep, without running again", async () => {
  const { app, registry } = setup({ ...outbox(db), deliver: async () => {} }); // committed, then the process died
  await app.run(add, { name: "rug" });
  await db.update(outboxTable).set({ attempts: 2 }); // it died on its second and last try too
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 });
  expect(ran).toEqual([]);
  expect(await rows()).toMatchObject([{ status: "failed", attempts: 3 }]);
});

test("delay: the row waits unclaimed until it's due, then a sweep runs it", async () => {
  const later = listener({ event: () => added, delay: 60, async handler(_ctx, { name }) { ran.push(`later ${name}`); } });
  const registry = createRegistry({ modules: { x: { added, add, react, later } }, database: drizzleAdapter(db), jobs: { adapter: outbox(db) }, onError: () => {} });
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

test("via: the jobs of one commit go in one send", async () => {
  const also = listener({ event: () => added, async handler() {} });
  const via = fakeVia();
  const registry = createRegistry({ modules: { x: { added, add, react, also } }, database: drizzleAdapter(db), jobs: { adapter: outbox(db, { via }) } });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(via.sends).toBe(1);
  expect(via.got).toHaveLength(2);
  expect(await rows()).toEqual([]);
});

test("via: a job that fails for good in the consumer comes back as a failed row, even if the handoff's delete lands after", async () => {
  let consumer: ReturnType<typeof setup>["registry"] | undefined;
  const via = { async deliver(jobs: Delivery[]) {
    for (const job of jobs) await consumer!.jobs.run(job, { attempt: 2 }); // the queue ran it before this request deleted the row
  } };
  const { app, registry } = setup(outbox(db, { via }));
  consumer = registry;
  next = "throw";
  await app.run(add, { name: "lamp" });
  const [row] = await rows();
  expect(row).toMatchObject({ status: "failed", lastError: "smtp down" });
  next = "ok";
  expect(await registry.jobs.retry(row!.id)).toBe(true);
});

test("outbox(db) must share the registry's database: it writes in the mutation's transaction", () => {
  const other = drizzle({ client: pg });
  expect(() => createRegistry({ modules: {}, database: drizzleAdapter(db), jobs: { adapter: outbox(other) } })).toThrow(/must use the same database as `database`/);
});

test("a job whose listener was renamed or removed is failed at once with why, and retry runs it once the code is back", async () => {
  const { registry } = setup();
  const envelope = { id: "e", name: "x.added", payload: { name: "gone" }, scope: { actor: "ana" }, occurredAt: "", depth: 1 };
  await db.insert(outboxTable).values({ id: "x.react@e", delivery: { kind: "delivery", id: "x.react@e", listener: "x.removed", envelope, attempts: 1 } });
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 1, discarded: 0, retrying: 0 });
  expect(await rows()).toMatchObject([{ status: "failed", lastError: expect.stringMatching(/x\.removed isn't a registered listener/) }]);
  // the code is back (here: the row points at a listener that exists)
  await db.update(outboxTable).set({ delivery: { kind: "delivery", id: "x.react@e", listener: "x.react", envelope, attempts: 1 } });
  expect(await registry.jobs.retry("x.react@e")).toBe(true);
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["gone#1"]);
});

test("a listener's attempts beyond maxAttempts still get their tries", async () => {
  const stubborn = listener({ event: () => added, attempts: 4, async handler() { ran.push("stubborn"); throw new Error("still down"); } });
  const registry = createRegistry({ modules: { x: { added, add, stubborn } }, database: drizzleAdapter(db), jobs: { adapter: outbox(db, { maxAttempts: 2 }) }, onError: () => {} });
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
  const died = { ...outbox(db), deliver: async () => {} }; // committed, then the process died before delivering
  const registry = createRegistry({ modules: { x: { added, add, once } }, database: drizzleAdapter(db), jobs: { adapter: died }, onError: () => {} });
  await registry.as({ actor: "ana" }).run(add, { name: "desk" });
  expect(await rows()).toMatchObject([{ status: "pending", attempts: 0 }]);
  await makeDue(); // the lease ran out
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["once desk"]);
});

test("sweep({ limit }) claims at most that many", async () => {
  const { app, registry } = setup({ ...outbox(db), deliver: async () => {} });
  await app.run(add, { name: "a" });
  await app.run(add, { name: "b" });
  await makeDue();
  expect(await registry.jobs.sweep({ limit: 1 })).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(await rows()).toHaveLength(1);
});

test("crons: several servers ticking the same minute run each cron once, and old runs are pruned", async () => {
  const tidy = mutation({ async handler(ctx) { await ctx.db.insert(items).values({ name: `tidied ${ran.length}` }); ran.push("tidy"); } });
  const nightly = cron({ schedule: "0 3 * * *", run: tidy, scope: { actor: "system" } });
  const make = () => createRegistry({ modules: { x: { tidy, nightly } }, database: drizzleAdapter(db), jobs: { adapter: outbox(db) } });
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
  const registry = createRegistry({ modules: { x: { remind, book } }, database: drizzleAdapter(db), jobs: { adapter: outbox(db) }, onError: () => {} });
  await registry.as({ actor: "ana" }).run(book);
  const [row] = await rows();
  expect(row).toMatchObject({ id: expect.stringMatching(/^x\.remind@/), status: "pending", attempts: 0, delivery: { kind: "call", fn: "x.remind" } });
  expect(row!.availableAt.getTime() - Date.now()).toBeGreaterThan(3500_000);
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 });
  await makeDue();
  expect(await registry.jobs.sweep()).toEqual({ done: 1, failed: 0, discarded: 0, retrying: 0 });
  expect(ran).toEqual(["remind guest"]);
});
