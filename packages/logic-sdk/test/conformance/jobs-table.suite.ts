// What the jobs table promises on any database, whatever runs its SQL: adapters/postgres.test.ts and adapters/sqlite.test.ts
// run this one list on every database and driver.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { init, type JobsAdapter, type Job, type SqlDatabase } from "../../src/index.ts";
import type { StoredJobs } from "../../src/postgres.ts";

export interface Target {
  databaseQueue(): StoredJobs;
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
        jobs: { adapter: (adapter ?? target.databaseQueue)(), scope: { load: (saved) => saved } },
        onError: () => {},
      });
      return { registry, as: registry.as({ who: "ana" }), add, book, nightly, ran, state };
    }
    const rows = () => run("select id, status from logic_jobs");
    const makeDue = () => run(`update logic_jobs set available_at = ${target.past} where status = 'pending'`);

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

    test("outbox: the queue gets it and the row goes; what the consumer fails comes back", async () => {
      const sent: Job[] = [];
      const queue = { async deliver(jobs: Job[]) { sent.push(...jobs); } };
      const { registry, as, add, state } = await app(() => target.outbox(queue));
      await as.run(add, { name: "desk" });
      expect(sent).toHaveLength(1);
      expect(await rows()).toEqual([]);
      state.down = true;
      expect(await registry.jobs.run(sent[0]!, { attempt: 2 })).toBe("failed");
      expect((await registry.jobs.failed()).jobs).toMatchObject([{ id: sent[0]!.id, error: expect.stringContaining(AWKWARD) }]);
    });
  });
}
