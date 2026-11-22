// What the jobs table promises on any database, whatever runs its SQL: every database and driver runs this one list.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { init, type Dispatcher, type Job, type SqlDatabase } from "../src/index.ts";
import type { StoredJobs } from "../src/stored-jobs.ts";

export interface Target {
  databaseQueue(database: SqlDatabase): StoredJobs;
  outbox(database: SqlDatabase, queue: Dispatcher): StoredJobs;
  /** `$1` on Postgres, `?` on SQLite. */
  param: string;
  /** A time that's over, in SQL. */
  past: string;
  /** A database with the jobs tables and `seam_items (name text)`. */
  open(): Promise<{ database: SqlDatabase; close(): Promise<void> }>;
}

// what breaks a seam that builds SQL from text, or encodes JSON twice
const AWKWARD = `it's "quoted" \\ $1 ?2 ? :name {"a":1}\nline two ñ 🚀`;

export function seamScenarios(name: string, target: Target) {
  describe(name, () => {
    let running: Awaited<ReturnType<Target["open"]>>;
    beforeAll(async () => {
      running = await target.open();
    });
    afterAll(() => running.close());

    // spread: postgres.js's rows are an Array subclass, which toMatchObject won't match to a plain one
    const run = async (text: string, params: unknown[] = []) => [...(await running.database.query(running.database.db, text, params))];

    async function app(adapter?: (database: SqlDatabase) => Dispatcher) {
      const { database } = running;
      await run("delete from logic_jobs");
      await run("delete from logic_cron_runs");
      await run("delete from seam_items");
      const { mutation, action, event, listener, cron, createRegistry } = init<{ scope: { who: string }; db: any }>();
      const ran: string[] = [];
      const state = { down: false };
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
      const book = mutation({ input: z.object({ at: z.string() }), async handler(ctx, { at }) { ctx.schedule(remind, { at }, { delay: 3600, replace: "b1" }); } });
      const tidy = mutation({ async handler() { ran.push("tidy"); } });
      const nightly = cron({ schedule: "0 3 * * *", run: tidy, scope: { who: "system" } });
      const registry = createRegistry({
        modules: { x: { added, add, react, remind, book, tidy, nightly } },
        database,
        jobs: { adapter: (adapter ?? target.databaseQueue)(database), scope: { load: (saved) => saved } },
        onError: () => {},
      });
      return { registry, as: registry.as({ who: "ana" }), add, book, ran, state };
    }
    const rows = () => run("select id, status, last_error from logic_jobs");
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
      const [failed] = await rows();
      expect(failed).toMatchObject({ status: "failed", last_error: expect.stringContaining(AWKWARD) });
      state.down = false;
      expect(await registry.jobs.retry(String(failed!.id))).toBe(true);
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(ran).toEqual(["lamp#1 as ana", "lamp#2 as ana", "lamp#1 as ana"]);
    });

    test("a crash after commit: a sweep runs it once, as a first try", async () => {
      const { registry, as, add, ran } = await app((database) => ({ ...target.databaseQueue(database), deliver: async () => {} }));
      await as.run(add, { name: "rug" });
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 }); // still its request's to run
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 });
      expect(ran).toEqual(["rug#1 as ana"]);
    });

    test("a scheduled call waits, and a newer one with its key replaces it", async () => {
      const { registry, as, book, ran } = await app();
      await as.run(book, { at: "July 3" });
      await as.run(book, { at: "July 9" });
      expect(await rows()).toHaveLength(1);
      expect(await registry.jobs.sweep()).toMatchObject({ done: 0 }); // not due
      await makeDue();
      expect(await registry.jobs.sweep()).toMatchObject({ done: 1 });
      expect(ran).toEqual(["July 9"]);
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
      const { registry, as, add, state } = await app((database) => target.outbox(database, queue));
      await as.run(add, { name: "desk" });
      expect(sent).toHaveLength(1);
      expect(await rows()).toEqual([]);
      state.down = true;
      expect(await registry.jobs.run(sent[0]!, { attempt: 2 })).toBe("failed");
      expect(await rows()).toMatchObject([{ status: "failed", last_error: expect.stringContaining(AWKWARD) }]);
    });
  });
}
