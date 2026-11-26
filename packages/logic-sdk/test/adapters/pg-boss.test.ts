import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { fromPglite, PgBoss } from "pg-boss";
import postgres from "postgres";
import { z } from "zod";
import { drizzleAdapter } from "../../src/drizzle/pg.ts";
import { init, storedReplaceKey, type DatabaseAdapter, type FailureInfo, type Job, type SqlDatabase } from "../../src/index.ts";
import { pgBoss, pgBossId, work, type PgBossMeta } from "../../src/pg-boss.ts";

// pg-boss polls and backs off in real time: these wait for its workers, a few seconds at most.
setDefaultTimeout(20_000);

type Scope = { actor: string };
const { mutation, event, listener, cron, createRegistry } = init<{ scope: Scope; db: unknown; meta: PgBossMeta }>();

/** What the jobs did, as `<name>#<attempt>`. */
let ran: string[] = [];
const fast = { pollingIntervalSeconds: 0.5 }; // pg-boss's default is 2 s
const added = event({ payload: z.object({ name: z.string() }) });
const add = mutation({
  input: z.object({ name: z.string() }),
  async handler(ctx, { name }) {
    ctx.emit(added, { name });
    if (name.startsWith("rolled-back")) throw ctx.errors.reject("no");
  },
});
const react = listener({
  event: () => added,
  attempts: 3,
  meta: { pgBoss: { queue: { retryDelayMax: 1, expireInSeconds: 120 }, worker: { ...fast, localConcurrency: 2 } } },
  async handler(ctx, { name }) {
    ran.push(`${name}#${ctx.event.attempt}`);
    if (name.startsWith("flaky")) throw new Error("smtp down");
    if (name.startsWith("denied")) throw ctx.errors.reject("nope");
  },
});

const noted = event({ payload: z.object({ name: z.string() }) });
const note = mutation({
  input: z.object({ name: z.string() }),
  async handler(ctx, { name }) {
    ctx.emit(noted, { name });
  },
});
const later = listener({
  event: () => noted,
  delay: 1,
  meta: { pgBoss: { worker: fast } },
  async handler(_ctx, { name }) {
    ran.push(`${name}#later`);
  },
});

const remind = mutation({
  input: z.object({ n: z.number() }),
  async handler(_ctx, { n }) {
    ran.push(`remind ${n}`);
    if (n < 0) throw new Error("not yet");
  },
});
const plan = mutation({
  input: z.object({ n: z.number(), delay: z.number(), replace: z.boolean().optional(), attempts: z.number().optional(), fail: z.boolean().optional() }),
  async handler(ctx, { n, delay, replace, attempts, fail }) {
    ctx.schedule(remind, { n }, { delay, attempts, ...(replace ? { replace: true as const } : {}) });
    if (fail) throw ctx.errors.reject("rolled back");
  },
});
/** The key a call to `x.remind` with `{ n }` waits under, as pg-boss's `singletonKey`. */
const keyFor = async (n: number) => (await storedReplaceKey({ kind: "call", id: "", fn: "x.remind", input: { n }, scope: {}, attempts: 1, depth: 0, replace: true }))!;

const system: Scope = { actor: "system" };
const digest = mutation({
  async handler() {
    ran.push("digest");
  },
});
const leapDay = cron({ schedule: "0 9 29 2 *", scope: system, handler: (ctx) => ctx.run(digest) }); // never due on the real clock: tests tick it

const modules = { x: { added, add, react, noted, note, later, remind, plan, digest, leapDay } };
const failures: FailureInfo[] = [];
const makeRegistry = (database: DatabaseAdapter<unknown, unknown>, boss: PgBoss) =>
  createRegistry({ modules, database: { adapter: database }, jobs: { adapter: pgBoss(boss), scope: { load: (saved) => saved } }, onError: (_e, info) => failures.push(info) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for pg-boss's workers. `performance.now()`, so a frozen `Date` doesn't freeze it. */
async function until(done: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = performance.now() + ms;
  while (!(await done())) {
    if (performance.now() > end) throw new Error(`timed out; ran: ${ran.join(", ")}`);
    await sleep(50);
  }
}

interface Backend {
  database: DatabaseAdapter<unknown, unknown>;
  newBoss(): PgBoss;
  close(): Promise<void>;
}

/** PGlite in process: pg-boss has an adapter for it, on the same instance as Drizzle. */
function pglite(): Backend {
  const pg = new PGlite();
  return {
    database: drizzleAdapter(drizzlePglite({ client: pg })),
    newBoss: () => new PgBoss({ db: fromPglite(pg), backend: "pglite" }),
    close: () => pg.close(),
  };
}

/** PGlite with no ORM: a database adapter another ORM's user would write. pg-boss runs through its `query`. */
function pgliteNoOrm(): Backend {
  const pg = new PGlite();
  const database: SqlDatabase = {
    db: pg,
    transaction: (fn) => pg.transaction(fn),
    query: async (on, text, params) => (await on.query(text, params)).rows,
  };
  return {
    database,
    newBoss: () => new PgBoss({ db: fromPglite(pg), backend: "pglite" }),
    close: () => pg.close(),
  };
}

/** Real Postgres (CI sets DATABASE_URL), with pg-boss in a schema of its own. */
function realPostgres(url: string): Backend {
  const schema = `logic_sdk_pgboss_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = postgres(url, { max: 5, onnotice: () => {} });
  return {
    database: drizzleAdapter(drizzlePostgres({ client })),
    newBoss: () => new PgBoss({ connectionString: url, schema, max: 5 }),
    async close() {
      await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    },
  };
}

const url = process.env.DATABASE_URL;
const backends: [string, () => Backend][] = [
  ["PGlite", pglite],
  ["PGlite, no ORM", pgliteNoOrm],
];
if (url) backends.push(["Postgres", () => realPostgres(url)]);

describe.each(backends)("pgBoss on %s", (_name, open) => {
  let backend: Backend;
  let boss: PgBoss;
  let registry: ReturnType<typeof makeRegistry>;
  let app: ReturnType<typeof registry.as>;
  const started: PgBoss[] = [];

  async function start() {
    const b = backend.newBoss();
    b.on("error", (e) => console.error("[pg-boss]", e));
    await b.start();
    started.push(b);
    return b;
  }
  // the jobs adapters suite (adapters/jobs-adapters.test.ts) runs pgBoss with Drizzle on PGlite and Postgres: here, the basics
  // it covers run on the adapter with no ORM only
  const noOrm = _name === "PGlite, no ORM";
  /** pg-boss's rows for a listener's job about `name`. */
  const rowsAbout = (listener: string, name: string) => boss.findJobs<Job>(`logic-sdk.${listener}`, { data: { envelope: { payload: { name } } } });
  const callRow = async (id: string) => (await boss.findJobs<Job>("logic-sdk.calls", { id: pgBossId(id) }))[0];
  /** The calls to `x.remind` with `{ n }`: ctx.schedule returns no id, so tests find them by input. */
  const callsFor = (n: number) => boss.findJobs<Job>("logic-sdk.calls", { data: { input: { n } } });

  beforeAll(async () => {
    backend = open();
    boss = await start();
    registry = makeRegistry(backend.database, boss);
    app = registry.as({ actor: "ana" });
    await work(registry, boss, { calls: { queue: { retryDelayMax: 1 }, worker: fast } });
  });
  afterAll(async () => {
    for (const b of started) await b.stop({ graceful: false });
    await backend.close();
  });

  if (noOrm) test("a committed mutation's job runs; a rolled-back one leaves none", async () => {
    ran = [];
    await app.run(add, { name: "ok" });
    await expect(app.run(add, { name: "rolled-back" })).rejects.toThrow("no");
    // pg-boss marks it completed after the handler returns, so wait for that, not for the handler
    await until(async () => (await rowsAbout("x.react", "ok"))[0]?.state === "completed");
    expect(ran).toEqual(["ok#1"]);
    expect(await rowsAbout("x.react", "rolled-back")).toEqual([]);
  });

  test("a listener's delay is pg-boss's startAfter: it waits, then runs", async () => {
    ran = [];
    await app.run(note, { name: "noted" });
    const [row] = await rowsAbout("x.later", "noted");
    expect(row?.state).toBe("created");
    expect(row?.startAfter.toISOString()).toBe(row?.data.runAt);
    expect(ran).toEqual([]);
    await until(() => ran.includes("noted#later"));
  });

  test("retries until its attempts are used, each with its attempt number; then it's failed", async () => {
    ran = [];
    failures.length = 0;
    await app.run(add, { name: "flaky" });
    await until(async () => (await rowsAbout("x.react", "flaky"))[0]?.state === "failed");
    expect(ran).toEqual(["flaky#1", "flaky#2", "flaky#3"]);
    const [row] = await rowsAbout("x.react", "flaky");
    expect(row?.output).toMatchObject({ message: "smtp down" }); // why, in pg-boss
    expect(failures.filter((f) => f.job?.id.startsWith("x.react@")).map((f) => f.outcome)).toEqual(["retry", "retry", "failed"]);
  });

  if (noOrm) test("a domain error fails it at once: no retries", async () => {
    ran = [];
    await app.run(add, { name: "denied" });
    await until(async () => (await rowsAbout("x.react", "denied"))[0]?.state === "failed");
    const [row] = await rowsAbout("x.react", "denied");
    expect(row?.retryCount).toBe(0);
    expect(ran).toEqual(["denied#1"]);
  });

  test("retry(id) puts a failed job back with a fresh set of attempts; only failed ones", async () => {
    ran = [];
    await app.run(add, { name: "flaky again" });
    await until(async () => (await rowsAbout("x.react", "flaky again"))[0]?.state === "failed");
    const [failed] = await rowsAbout("x.react", "flaky again");
    const id = failed?.data.id ?? "";

    expect(await registry.jobs.retry(id)).toBe(true);
    expect(await registry.jobs.retry(id)).toBe(false); // waiting again: it belongs to pg-boss's workers
    await until(async () => (await rowsAbout("x.react", "flaky again"))[0]?.state === "failed");
    expect(ran).toEqual(["flaky again#1", "flaky again#2", "flaky again#3", "flaky again#1", "flaky again#2", "flaky again#3"]);
    expect(await registry.jobs.retry("x.react@no-such-event")).toBe(false);
  });

  if (noOrm) test("crons: two servers ticking the same minute make one run", async () => {
    ran = [];
    const other = makeRegistry(backend.database, boss); // another server's registry
    const at = new Date("2028-02-29T09:00:00Z");
    expect(await registry.jobs.tick(at)).toEqual(["x.leapDay"]);
    expect(await other.jobs.tick(at)).toEqual(["x.leapDay"]);
    expect(await boss.findJobs("logic-sdk.x.leapDay")).toHaveLength(1); // one row, so one run
    await until(() => ran.includes("digest"));
  });

  test("ctx.schedule: the call waits in the calls queue until it's due, then runs", async () => {
    ran = [];
    await app.run(plan, { n: 1, delay: 1 });
    const [row] = await callsFor(1);
    expect(row?.state).toBe("created");
    expect(row?.id).toBe(pgBossId(row!.data.id));
    expect(row?.startAfter.toISOString()).toBe(row?.data.runAt);
    await until(() => ran.includes("remind 1"));
  });

  test("ctx.schedule replace: the waiting call with the same input becomes the new one; a rollback leaves it", async () => {
    await app.run(plan, { n: 10, delay: 60, replace: true });
    const [first] = await callsFor(10);
    await app.run(plan, { n: 10, delay: 120, replace: true }); // moved
    await expect(app.run(plan, { n: 10, delay: 30, replace: true, fail: true })).rejects.toThrow();
    await app.run(plan, { n: 11, delay: 60, replace: true }); // another input keeps its own

    const waiting = await boss.findJobs<Job>("logic-sdk.calls", { key: await keyFor(10) });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.id).not.toBe(first?.id);
    expect(waiting[0]!.startAfter.getTime() - Date.now()).toBeGreaterThan(90_000); // the 120 s call, not the rolled-back one
    expect(await boss.findJobs<Job>("logic-sdk.calls", { key: await keyFor(11) })).toHaveLength(1);
  });

  test("ctx.schedule replace: two transactions replacing the same call at once leave one waiting", async () => {
    await Promise.all([60, 61, 62].map((delay) => app.run(plan, { n: 20, delay, replace: true })));
    expect(await boss.findJobs<Job>("logic-sdk.calls", { key: await keyFor(20) })).toHaveLength(1);
  });

  test("ctx.schedule replace: a call that started isn't touched; the new one waits beside it", async () => {
    ran = [];
    await app.run(plan, { n: -1, delay: 0, attempts: 2, replace: true });
    const [started] = await callsFor(-1);
    await until(async () => (await callRow(started!.data.id))?.state === "retry"); // failed its first try: back in line with one left
    await app.run(plan, { n: -1, delay: 60, replace: true });

    const rows = await boss.findJobs<Job>("logic-sdk.calls", { key: await keyFor(-1) });
    expect(rows).toHaveLength(2);
    expect(rows.filter((j) => j.state === "created").map((j) => j.data.id)).not.toContain(started!.data.id);
  });

  test("retry(id) of a scheduled call: back with a fresh set, and no longer replaceable; forget deletes a failed one", async () => {
    ran = [];
    await app.run(plan, { n: -2, delay: 0, replace: true }); // one try: it fails for good
    const id = (await callsFor(-2))[0]!.data.id;
    await until(async () => (await callRow(id))?.state === "failed");
    expect(await registry.jobs.retry(id)).toBe(true);
    expect((await callRow(id))?.singletonKey).toBeNull(); // its key went: it has run
    await until(() => ran.filter((r) => r === "remind -2").length === 2);
    await until(async () => (await callRow(id))?.state === "failed");

    await app.run(plan, { n: 3, delay: 600 });
    const waiting = (await callsFor(3))[0]!.data.id;
    expect(await registry.jobs.forget(waiting)).toBe(false); // waiting: never touched
    expect(await registry.jobs.forget(id)).toBe(true);
    expect(await callRow(id)).toBeUndefined();
    expect(await registry.jobs.forget(id)).toBe(false);
    await expect(registry.jobs.failed()).rejects.toThrow(/can't list failed jobs.*use boss\.findJobs/);
  });

  test.skipIf(_name.startsWith("PGlite"))("a process that enqueues before any work() creates the queue it needs", async () => {
    // PGlite has one connection, so pg-boss's own lookup would wait for the open transaction: run work() first there
    const fresh = listener({ event: () => added, meta: { pgBoss: { queue: { expireInSeconds: 77 } } }, async handler() {} });
    const enqueuer = await start(); // a web process: started, never called work()
    const web = createRegistry({ modules: { x: modules.x, y: { fresh } }, database: { adapter: backend.database }, jobs: { adapter: pgBoss(enqueuer), scope: { load: (saved) => saved } } });
    await web.as({ actor: "ana" }).run(add, { name: "first" });
    expect(await enqueuer.findJobs<Job>("logic-sdk.y.fresh", { data: { envelope: { payload: { name: "first" } } } })).toHaveLength(1);
    expect(await enqueuer.getQueue("logic-sdk.y.fresh")).toMatchObject({ expireInSeconds: 77 }); // created with its meta
  });

  test("meta.pgBoss tunes the listener's queue and its workers", async () => {
    const queue = await boss.getQueue("logic-sdk.x.react");
    expect(queue).toMatchObject({ expireInSeconds: 120, retryDelayMax: 1 });
    const workers = boss.getWipData().filter((w) => w.name === "logic-sdk.x.react");
    expect(workers.every((w) => w.options.localConcurrency === 2 && w.options.perJobResults === true)).toBe(true);
    expect(workers.length).toBeGreaterThan(0);
  });

  test("work() ticks crons on the minute, and boss.stop() stops it", async () => {
    const ticks = { running: 0, stopped: 0 };
    const spy = (count: "running" | "stopped") => ({
      definitions: registry.definitions,
      jobs: {
        ...registry.jobs,
        async tick() {
          ticks[count]++;
          return [];
        },
      },
    });
    const running = await start();
    const stopping = await start();
    setSystemTime(new Date("2026-11-23T09:00:58.500Z")); // the next minute is 1.5 s away, and stays so
    try {
      await work(spy("running"), running);
      await work(spy("stopped"), stopping);
      await stopping.stop();
      await sleep(2000);
    } finally {
      setSystemTime();
    }
    expect(ticks).toEqual({ running: 1, stopped: 0 });
    await running.stop();
  });
});
