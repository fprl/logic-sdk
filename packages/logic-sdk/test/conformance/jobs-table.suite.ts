// What the jobs table promises on any database, whatever runs its SQL: adapters/postgres.test.ts and adapters/sqlite.test.ts
// run this one list on every database and driver.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { z } from "zod";
import { inProcess, init, type JobsAdapter, type Job, type SqlDatabase } from "../../src/index.ts";
import type { DatabaseQueueOptions, StoredJobs } from "../../src/postgres.ts";

export interface Target {
  databaseQueue(options?: DatabaseQueueOptions): StoredJobs;
  outbox(queue: JobsAdapter): StoredJobs;
  /** `$1` on Postgres, `?` on SQLite. */
  param: string;
  /** A time that's over, in SQL. */
  past: string;
  /** A database with the jobs tables and `seam_items (name text)`. */
  open(): Promise<{ database: SqlDatabase; close(): Promise<void> }>;
}

// what breaks a seam that builds SQL from text, or encodes JSON twice
const AWKWARD = `it's "quoted" \\ $1 ?2 ? :name {"a":1}\nline two ñ 🚀`;

export function jobsTableSuite(name: string, target: Target) {
  describe(name, () => {
    let running: Awaited<ReturnType<Target["open"]>>;
    beforeAll(async () => {
      running = await target.open();
    });
    afterAll(() => running.close());

    // spread: postgres.js's rows are an Array subclass, which toMatchObject won't match to a plain one
    const run = async (text: string, params: unknown[] = []) => [...(await running.database.query(running.database.db, text, params))];

    async function app(adapter?: () => JobsAdapter) {
      const { database } = running;
      await run("delete from logic_jobs");
      await run("delete from logic_cron_runs");
      await run("delete from seam_items");
      const { mutation, action, event, listener, cron, createRegistry } = init<{ scope: { who: string }; db: any }>();
      const ran: string[] = [];
      const state = { down: false, cronDown: false, minutes: [] as string[] };
      const added = event({ payload: z.object({ name: z.string() }) });
      const add = mutation({
        input: z.object({ name: z.string(), rollback: z.boolean().optional() }),
        async handler(ctx, { name, rollback }) {
          await database.query(ctx.db, `insert into seam_items (name) values (${target.param})`, [name]);
          ctx.emit(added, { name });
          if (rollback) throw ctx.errors.reject("no");
        },
      });
      const react = listener({
        event: () => added,
        attempts: 2,
        async handler(ctx, { name }) {
          ran.push(`${name}#${ctx.event.attempt} as ${ctx.scope.who}`);
          if (state.down) throw new Error(AWKWARD);
        },
      });
      const remind = action({ input: z.object({ at: z.string() }), async handler(_ctx, { at }) { ran.push(at); } });
      const book = mutation({
        input: z.object({ at: z.string(), delay: z.number() }),
        async handler(ctx, { at, delay }) {
          ctx.schedule(remind, { at }, { delay, replace: true });
        },
      });
      const tidy = mutation({ async handler() { ran.push("tidy"); } });
      const nightly = cron({
        schedule: "0 3 * * *",
        scope: { who: "system" },
        async handler(ctx) {
          state.minutes.push(ctx.cron.scheduledAt);
          if (state.cronDown) throw new Error("cron down");
          await ctx.run(tidy);
        },
      });
      const registry = createRegistry({
        modules: { x: { added, add, react, remind, book, tidy, nightly } },
        database: { adapter: database },
        jobs: { adapter: (adapter ?? target.databaseQueue)(), scope: { load: (_ctx, saved) => saved } },
        onError: () => {},
      });
      return { registry, as: registry.as({ who: "ana" }), add, book, nightly, ran, state };
    }
    /** A chat (a listener with a `key`) and a search index (one with `unique`), on `databaseQueue()` or `adapter`. */
    async function keyedApp(adapter: () => JobsAdapter = target.databaseQueue) {
      const { database } = running;
      await run("delete from logic_jobs");
      const { mutation, event, listener, createRegistry } = init<{ scope: { who: string }; db: any }>();
      const ran: string[] = [];
      const failing = new Set<string>();
      const holds = new Map<string, Promise<void>>();
      const opens = new Map<string, () => void>();
      /** `text`'s job waits in its handler until `open(text)`. */
      const hold = (text: string) => holds.set(text, new Promise((resolve) => opens.set(text, resolve)));
      const open = (text: string) => opens.get(text)?.();
      /** What `text`'s job does as it runs. */
      const does = new Map<string, () => void>();
      const said = event({ payload: z.object({ conversation: z.string(), text: z.string() }) });
      const say = mutation({ input: said.payload, async handler(ctx, message) { ctx.emit(said, message); } });
      const sayAll = mutation({
        input: z.object({ conversation: z.string(), texts: z.array(z.string()) }),
        async handler(ctx, { conversation, texts }) {
          for (const text of texts) ctx.emit(said, { conversation, text });
        },
      });
      const reply = listener({
        event: () => said,
        key: (m) => m.conversation,
        attempts: 2,
        async handler(ctx, { text }) {
          ran.push(`${text}#${ctx.event.attempt}`);
          does.get(text)?.();
          await holds.get(text);
          if (failing.has(text)) throw new Error("try again");
        },
      });
      const changed = event({ payload: z.object({ product: z.string() }) });
      const change = mutation({ input: changed.payload, async handler(ctx, p) { ctx.emit(changed, p); } });
      const reindex = listener({
        event: () => changed,
        unique: (p) => p.product,
        delay: 60,
        async handler(_ctx, { product }) {
          ran.push(`reindex ${product}`);
          await holds.get(product);
        },
      });
      const registry = createRegistry({
        modules: { x: { said, say, sayAll, reply, changed, change, reindex } },
        database: { adapter: database },
        jobs: { adapter: adapter(), scope: { load: (_ctx, saved) => saved } },
        onError: () => {},
      });
      return { registry, as: registry.as({ who: "ana" }), say, sayAll, change, ran, failing, hold, open, does };
    }
    /** Resolves once `ready()` holds: for a job that's started in another request. */
    async function until(ready: () => boolean) {
      for (let i = 0; i < 400 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(ready()).toBe(true);
    }
    const rows = () => run("select id, status from logic_jobs");
    const makeDue = () => run(`update logic_jobs set available_at = ${target.past} where status = 'pending'`);

    test("key: one job at a time per key, in order; the next waits without spending an attempt and runs right after", async () => {
      const { as, say, ran, hold, open } = await keyedApp();
      hold("hi");
      const first = as.run(say, { conversation: "c1", text: "hi" });
      await until(() => ran.includes("hi#1"));
      await as.run(say, { conversation: "c1", text: "there" }); // committed, and waits for "hi"
      await as.run(say, { conversation: "c2", text: "yo" }); // another key: runs now
      expect(ran).toEqual(["hi#1", "yo#1"]);
      open("hi");
      await first; // its runner runs the key's next job, as a first try
      expect(ran).toEqual(["hi#1", "yo#1", "there#1"]);
      expect(await rows()).toEqual([]);
    });

    test("key: a try backing off holds its key; a job that failed for good frees it", async () => {
      const { registry, as, say, ran, failing } = await keyedApp();
      failing.add("hi");
      await as.run(say, { conversation: "c1", text: "hi" }); // try 1 fails: backing off
      await as.run(say, { conversation: "c1", text: "there" });
      expect(ran).toEqual(["hi#1"]);
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ failed: 1 }); // "hi" is out of tries, so "there" runs
      expect(ran).toEqual(["hi#1", "hi#2", "there#1"]);
      expect(await rows()).toMatchObject([{ status: "failed" }]);
    });

    test("key: a failed job put back with retry(id) waits behind the one that started after it, then runs", async () => {
      const { registry, as, say, ran, failing } = await keyedApp();
      failing.add("hi");
      await as.run(say, { conversation: "c1", text: "hi" });
      await makeDue();
      await registry.jobs.sweep(); // "hi" fails for good
      failing.add("there");
      await as.run(say, { conversation: "c1", text: "there" }); // starts, fails once: backing off, holding the key
      const { jobs: [hi] } = await registry.jobs.failed();
      failing.clear();
      expect(await registry.jobs.retry(hi!.id)).toBe(true);
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 2 }); // "there" first (it started), then "hi"
      expect(ran).toEqual(["hi#1", "hi#2", "there#1", "there#2", "hi#1"]);
    });

    /** A queue that keeps what it's sent, and can hold it until its `runAt`, for a test to deliver as a consumer would: in any order, more than once. */
    function heldQueue() {
      const sent: Job[] = [];
      return { sent, queue: { holds: true as const, async deliver(jobs: Job[]) { sent.push(...structuredClone(jobs)); } } };
    }

    test("outbox and key: the queue gets one signal per key and the rows stay; signals in any order, twice, run each job once, in order", async () => {
      const { sent, queue } = heldQueue();
      const { registry, as, say, sayAll, ran } = await keyedApp(() => target.outbox(queue));
      await as.run(sayAll, { conversation: "c1", texts: ["hi", "there"] });
      await as.run(say, { conversation: "c1", text: "again" });
      await as.run(say, { conversation: "c2", text: "yo" });
      expect(ran).toEqual([]);
      expect(sent.map((j) => j.kind === "delivery" && j.envelope.payload)).toEqual([
        { conversation: "c1", text: "hi" },
        { conversation: "c1", text: "again" },
        { conversation: "c2", text: "yo" },
      ]);
      expect(await rows()).toHaveLength(4);
      for (const signal of [...sent].reverse().concat(sent)) expect(await registry.jobs.run(signal)).toBe("done");
      expect(ran).toEqual(["yo#1", "hi#1", "there#1", "again#1"]); // "again"'s signal came first, and ran its key from the top
      expect(await rows()).toEqual([]);
    });

    test("outbox and key: with the signal lost, the sweep runs the key here, in order; a try backing off holds it", async () => {
      const { registry, as, say, ran, failing } = await keyedApp(() => target.outbox({ async deliver() {} }));
      failing.add("hi");
      await as.run(say, { conversation: "c1", text: "hi" });
      await as.run(say, { conversation: "c1", text: "there" });
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ retrying: 1, done: 0 }); // "there" waits behind "hi"'s backoff
      failing.clear();
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 2 });
      expect(ran).toEqual(["hi#1", "hi#2", "there#1"]);
    });

    test("outbox and key: a consumer runs one key for a minute at most, then sends the rest on as one more signal", async () => {
      const { sent, queue } = heldQueue();
      const { registry, as, say, ran, does } = await keyedApp(() => target.outbox(queue));
      does.set("hi", () => setSystemTime(new Date(Date.now() + 61_000)));
      try {
        for (const text of ["hi", "there", "again"]) await as.run(say, { conversation: "c1", text });
        await registry.jobs.run(sent[0]!);
      } finally {
        setSystemTime();
      }
      expect(ran).toEqual(["hi#1"]);
      expect(sent).toHaveLength(4);
      await registry.jobs.run(sent[3]!);
      expect(ran).toEqual(["hi#1", "there#1", "again#1"]);
    });

    test("outbox and key: a queue that runs what it's sent itself runs the key from the table too", async () => {
      const { as, say, sayAll, ran } = await keyedApp(() => target.outbox(inProcess()));
      await as.run(sayAll, { conversation: "c1", texts: ["hi", "there"] });
      await as.run(say, { conversation: "c1", text: "again" });
      expect(ran).toEqual(["hi#1", "there#1", "again#1"]);
      expect(await rows()).toEqual([]);
    });

    test("unique: while a job with the value hasn't started, later ones are dropped; once it starts, the next is queued", async () => {
      const { registry, as, change, ran, hold, open } = await keyedApp();
      await as.run(change, { product: "p1" });
      await as.run(change, { product: "p1" });
      await as.run(change, { product: "p2" });
      expect(await rows()).toHaveLength(2); // one waiting per product
      await makeDue();
      hold("p1");
      const sweeping = registry.jobs.sweep();
      await until(() => ran.includes("reindex p1"));
      await as.run(change, { product: "p1" }); // the running one may have read the old data: a new job waits
      open("p1");
      expect(await sweeping).toMatchObject({ done: 2 });
      expect(ran.toSorted()).toEqual(["reindex p1", "reindex p2"]);
      expect(await rows()).toHaveLength(1);
    });

    test("a commit runs its job and deletes the row; a rollback leaves neither", async () => {
      const { as, add, ran } = await app();
      await as.run(add, { name: AWKWARD });
      expect(ran).toEqual([`${AWKWARD}#1 as ana`]);
      await expect(as.run(add, { name: "no", rollback: true })).rejects.toMatchObject({ kind: "rejected" });
      expect(await run("select name from seam_items")).toMatchObject([{ name: AWKWARD }]);
      expect(await rows()).toEqual([]);
    });

    test("a failure waits for its backoff, fails out of attempts with why, and retry(id) runs it again", async () => {
      const { registry, as, add, ran, state } = await app();
      state.down = true;
      await as.run(add, { name: "lamp" });
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0, failed: 0, retrying: 0 }); // its backoff isn't over
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ failed: 1 });
      const { jobs: [failed] } = await registry.jobs.failed();
      expect(failed).toMatchObject({ source: "x.react", error: expect.stringContaining(AWKWARD) });
      state.down = false;
      expect(await registry.jobs.retry(failed!.id)).toBe(true);
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(ran).toEqual(["lamp#1 as ana", "lamp#2 as ana", "lamp#1 as ana"]);
    });

    test("runIn worker: the request only writes the row, and a worker's claim takes it at once", async () => {
      const { registry, as, add, ran } = await app(() => target.databaseQueue({ runIn: "worker" }));
      await as.run(add, { name: "desk" });
      expect(ran).toEqual([]);
      expect(await registry.jobs.sweep({ limit: 1 })).toMatchObject({ done: 1 });
      expect(ran).toEqual(["desk#1 as ana"]);
    });

    test("a worker in this process: the request leaves its job to it and wakes it, and the row is free at once", async () => {
      const { registry, as, add, ran } = await app();
      const wakes: number[] = [];
      const detach = registry.jobs.attach({ wake: (count) => wakes.push(count) });
      await as.run(add, { name: "desk" });
      expect(ran).toEqual([]);
      expect(wakes).toEqual([1]);
      expect(await registry.jobs.sweep({ limit: 1 })).toMatchObject({ done: 1 });
      detach();
      await as.run(add, { name: "lamp" }); // no worker here anymore: the request runs it
      expect(ran).toEqual(["desk#1 as ana", "lamp#1 as ana"]);
      expect(wakes).toEqual([1]);
    });

    test("a worker in this process for other queues: the request runs the rest itself", async () => {
      const { database } = running;
      await run("delete from logic_jobs");
      const { mutation, event, listener, createRegistry } = init<{ scope: { who: string }; db: any }>();
      const ran: string[] = [];
      const sent = event({ payload: z.object({ to: z.string() }) });
      const send = mutation({ input: sent.payload, async handler(ctx, input) { ctx.emit(sent, input); } });
      const mail = listener({ event: () => sent, queue: "mail", async handler(_ctx, { to }) { ran.push(`mail ${to}`); } });
      const index = listener({ event: () => sent, async handler(_ctx, { to }) { ran.push(`index ${to}`); } });
      const registry = createRegistry({ modules: { x: { sent, send, mail, index } }, database: { adapter: database }, jobs: { adapter: target.databaseQueue(), queues: ["mail"], scope: { load: (_ctx, s) => s } }, onError: () => {} });
      const detach = registry.jobs.attach({ wake: () => {}, queues: ["mail"] });
      await registry.as({ who: "ana" }).run(send, { to: "bo" }); // one of its jobs isn't the worker's: all run here
      detach();
      expect(ran.sort()).toEqual(["index bo", "mail bo"]);
    });

    test("queues: a sweep takes the queues it's asked for, first queue first, and a job without one is default's", async () => {
      const { database } = running;
      await run("delete from logic_jobs");
      const { mutation, event, listener, createRegistry } = init<{ scope: { who: string }; db: any }>();
      const ran: string[] = [];
      const sent = event({ payload: z.object({ to: z.string() }) });
      const send = mutation({ input: sent.payload, async handler(ctx, input) { ctx.emit(sent, input); } });
      const index = listener({ event: () => sent, async handler(_ctx, { to }) { ran.push(`index ${to}`); } });
      const mail = listener({ event: () => sent, queue: "mail", async handler(_ctx, { to }) { ran.push(`mail ${to}`); } });
      const report = listener({ event: () => sent, queue: "reports", async handler(_ctx, { to }) { ran.push(`report ${to}`); } });
      const registry = createRegistry({
        modules: { x: { sent, send, index, mail, report } },
        database: { adapter: database },
        jobs: { adapter: target.databaseQueue({ runIn: "worker" }), queues: ["mail", "reports"], scope: { load: (_ctx, s) => s } },
        onError: () => {},
      });
      await registry.as({ who: "ana" }).run(send, { to: "bo" });
      await registry.as({ who: "ana" }).run(send, { to: "cy" });
      expect(await registry.jobs.sweep({ queues: ["mail", "default"] })).toMatchObject({ done: 4 });
      expect(ran).toEqual(["mail bo", "mail cy", "index bo", "index cy"]); // mail first, then default: reports wait
      expect(await registry.jobs.sweep({ queues: ["reports"] })).toMatchObject({ done: 2 });
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 });
    });

    test("a crash after commit: a sweep runs it once, as a first try", async () => {
      const { registry, as, add, ran } = await app(() => ({ ...target.databaseQueue(), deliver: async () => {} }));
      await as.run(add, { name: "rug" });
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 }); // still its request's to run
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 });
      expect(ran).toEqual(["rug#1 as ana"]);
    });

    test("a scheduled call waits, and a newer one with its input replaces it", async () => {
      const { registry, as, book, ran } = await app();
      await as.run(book, { at: "July 9", delay: 3600 });
      await as.run(book, { at: "July 9", delay: 7200 }); // moved
      expect(await rows()).toHaveLength(1);
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 }); // not due
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(ran).toEqual(["July 9"]);
    });

    test("failed: newest first, by source and by stored scope, a page at a time; forget deletes failed rows only", async () => {
      const { registry, add, book, ran, state } = await app();
      const as = (scope: object) => registry.as(scope as { who: string }); // stored as it was emitted
      state.down = true;
      await as({ who: "ana", org: { id: "o1", vip: true, note: null } }).run(add, { name: "a1" });
      await as({ who: "bo", org: { id: "o2", vip: false } }).run(add, { name: "b1" });
      await as({ who: "ana", org: { id: "o1", vip: true, note: null } }).run(add, { name: "a2" });
      await makeDue();
      await registry.jobs.sweep(); // their second tries fail too: out of attempts
      state.cronDown = true;
      await new Promise((resolve) => setTimeout(resolve, 5)); // a later millisecond, for SQLite's clock
      await registry.jobs.tick(new Date("2026-11-23T03:00:00Z")); // one try, failed last
      const named = (page: { jobs: { kind: string; job: Job }[] }) =>
        page.jobs.map(({ kind, job }) => (job.kind === "delivery" ? (job.envelope.payload as { name: string }).name : kind)).sort();

      const all = await registry.jobs.failed();
      expect(all.cursor).toBeNull();
      expect(all.jobs[0]).toMatchObject({ id: "x.nightly@20261123T0300Z", kind: "cron", source: "x.nightly", scope: undefined, error: expect.stringContaining("cron down") });
      expect(all.jobs[1]).toMatchObject({ kind: "delivery", source: "x.react", scope: { who: expect.any(String) }, error: expect.stringContaining(AWKWARD) });
      expect(Number.isNaN(Date.parse(all.jobs[1]!.failedAt))).toBe(false);
      expect(named(all)).toEqual(["a1", "a2", "b1", "cron"]);

      expect(named(await registry.jobs.failed({ scope: { org: { id: "o1" } } }))).toEqual(["a1", "a2"]);
      expect(named(await registry.jobs.failed({ scope: { who: "bo", org: { vip: false } } }))).toEqual(["b1"]);
      expect(named(await registry.jobs.failed({ scope: { org: { note: null } } }))).toEqual(["a1", "a2"]); // null matches null
      expect(named(await registry.jobs.failed({ scope: { who: "bo", org: { note: null } } }))).toEqual([]); // a missing field isn't null
      expect(named(await registry.jobs.failed({ scope: { org: { vip: 1 } } }))).toEqual([]); // true isn't 1
      expect(named(await registry.jobs.failed({ source: "x.react", scope: { who: "ana" } }))).toEqual(["a1", "a2"]);
      expect(named(await registry.jobs.failed({ source: "x.nightly" }))).toEqual(["cron"]);
      expect(named(await registry.jobs.failed({ source: "x.nightly", scope: { who: "system" } }))).toEqual([]); // a cron run stores no scope
      await expect(registry.jobs.failed({ scope: { org: {} } })).rejects.toThrow(/org is an empty object/);
      await expect(registry.jobs.failed({ scope: { who: ["ana"] } as never })).rejects.toThrow(/who is an array/);
      await expect(registry.jobs.failed({ limit: 0 })).rejects.toThrow(/takes 1 to 1000/);
      await expect(registry.jobs.failed({ cursor: "nope" })).rejects.toThrow(/takes the cursor of the page before/);

      const seen: string[] = []; // one at a time: rows that failed in the same instant still come once each
      let cursor: string | undefined;
      do {
        const page = await registry.jobs.failed({ limit: 1, cursor });
        seen.push(...page.jobs.map((j) => j.id));
        cursor = page.cursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(all.jobs.map((j) => j.id));

      await as({ who: "ana" }).run(book, { at: "July 9", delay: 3600 }); // a waiting row
      const waiting = (await rows()).find((r) => r.status === "pending")!;
      expect(await registry.jobs.forget(String(waiting.id))).toBe(false); // never touched
      expect(await registry.jobs.forget("x.nightly@20261123T0300Z")).toBe(true);
      expect(await registry.jobs.forget("x.nightly@20261123T0300Z")).toBe(false);
      expect(named(await registry.jobs.failed())).toEqual(["a1", "a2", "b1"]);
      expect(ran.filter((r) => r === "tidy")).toEqual([]);
    });

    test("invoke: a cron now, through the adapter, beside the minute's own tick; a failed one is kept under its id", async () => {
      const { registry, nightly, ran, state } = await app();
      const id = await registry.jobs.invoke("x.nightly", { at: new Date("2026-11-23T03:00:30Z") });
      expect(id).toMatch(/^x\.nightly@20261123T0300Z-[0-9a-f-]{36}$/);
      expect(ran).toEqual(["tidy"]);
      expect(await registry.jobs.tick(new Date("2026-11-23T03:00:00Z"))).toEqual(["x.nightly"]);
      expect(ran).toEqual(["tidy", "tidy"]); // the real tick for that minute still ran
      await registry.jobs.invoke(nightly, { at: new Date("2026-11-23T15:42:00Z") }); // the cron itself, at a minute it isn't due
      await registry.jobs.invoke(nightly, { at: new Date("2026-11-23T15:42:00Z") }); // and again: each invoke is a run
      expect(ran).toEqual(["tidy", "tidy", "tidy", "tidy"]);
      expect(state.minutes).toEqual(["2026-11-23T03:00:00.000Z", "2026-11-23T03:00:00.000Z", "2026-11-23T15:42:00.000Z", "2026-11-23T15:42:00.000Z"]);
      expect(await rows()).toEqual([]);

      state.cronDown = true;
      const failed = await registry.jobs.invoke("x.nightly");
      expect((await registry.jobs.failed({ source: "x.nightly" })).jobs.map((j) => j.id)).toEqual([failed]);
      state.cronDown = false;
      expect(await registry.jobs.retry(failed)).toBe(true);
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(ran).toHaveLength(5);

      await expect(registry.jobs.invoke("x.nope")).rejects.toThrow(/no cron has that id \(x\.nightly\)/);
      await expect(registry.jobs.invoke("x.nightly", { at: new Date("nope") })).rejects.toThrow(/needs a valid date/);
    });

    test("crons: a minute ticked twice runs once", async () => {
      const { registry, ran } = await app();
      const at = new Date("2026-11-23T03:00:00Z");
      await registry.jobs.tick(at);
      await registry.jobs.tick(at);
      expect(ran).toEqual(["tidy"]);
    });

    test("outbox: every job stays a row and the commit sends one signal each; the consumer runs the row once", async () => {
      const { sent, queue } = heldQueue();
      const { registry, as, add, ran } = await app(() => target.outbox(queue));
      await as.run(add, { name: "desk" });
      expect(ran).toEqual([]);
      expect(await rows()).toMatchObject([{ status: "pending" }]);
      expect(await registry.jobs.run(sent[0]!)).toBe("done");
      expect(await registry.jobs.run(sent[0]!)).toBe("done"); // delivered twice: the row is gone, nothing to do
      expect(ran).toEqual(["desk#1 as ana"]);
      expect(await rows()).toEqual([]);
    });

    test("outbox: a failed try backs off as a row and its retry is signalled for when the backoff ends; out of tries it's failed", async () => {
      const { sent, queue } = heldQueue();
      const { registry, as, add, ran, state } = await app(() => target.outbox(queue));
      state.down = true;
      await as.run(add, { name: "lamp" });
      expect(await registry.jobs.run(sent[0]!)).toBe("done");
      expect(Date.parse(sent[1]!.runAt!)).toBeGreaterThan(Date.now()); // the retry's signal waits for the backoff
      expect(await registry.jobs.run(sent[1]!)).toBe("done"); // early: still backing off, so nothing runs
      await makeDue();
      await registry.jobs.run(sent[1]!);
      expect(ran).toEqual(["lamp#1 as ana", "lamp#2 as ana"]);
      expect(await rows()).toMatchObject([{ status: "failed" }]);
    });

    test("outbox: a delay longer than the queue holds gets no signal, and the sweep runs it when it's due", async () => {
      const sent: Job[] = [];
      const { registry, as, book, ran } = await app(() => target.outbox({ holds: { max: 60 }, async deliver(jobs) { sent.push(...jobs); } }));
      await as.run(book, { at: "soon", delay: 30 });
      await as.run(book, { at: "later", delay: 3600 });
      expect(sent.map((job) => job.kind === "call" && job.input)).toEqual([{ at: "soon" }]);
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 2 });
      expect(ran.toSorted()).toEqual(["later", "soon"]);
    });

    test("outbox: with the signal lost, the sweep runs the row here, once it's well past due", async () => {
      const { registry, as, add, ran } = await app(() => target.outbox({ async deliver() { throw new Error("queue down"); } }));
      await as.run(add, { name: "rug" });
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 }); // still its signal's
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(ran).toEqual(["rug#1 as ana"]);
    });
  });
}
