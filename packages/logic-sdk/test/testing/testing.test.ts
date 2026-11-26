// logic-sdk/testing: createTestRegistry, and t.jobs.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, init } from "../../src/index.ts";
import { createTestRegistry } from "../../src/testing.ts";
import { action, add, cron, cronSetup, inline, items, log, mutation, scheduleSetup, setup, system, type Scope } from "../support/app.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

test("testing: rollback per test, stubs, recorded events, frozen time", async () => {
  const { registry, db } = setup();
  const t = createTestRegistry(registry, { now: "2026-07-01T10:00:00Z", services: { log: [] } });
  const app = t.as({ actor: "ana", locale: "es" }); // bound once, works in every test
  await t.begin();
  await app.run(items.add, { name: "inside" });
  expect(t.events.map((e) => [e.name, e.occurredAt])).toEqual([["items.added", "2026-07-01T10:00:00.000Z"]]);
  expect((t.db as Store).rows.items).toEqual([{ name: "inside" }]);
  t.stub(items.add, async () => ({ name: "stubbed" }));
  expect(await app.run(items.greet, { name: "x" })).toEqual({ name: "stubbed" });
  await t.rollback();
  expect(db.store.rows.items).toEqual(undefined);
});

test("testing: a failing mutation inside a test rolls back only itself", async () => {
  const { registry } = setup();
  const t = createTestRegistry(registry);
  await t.begin();
  const app = t.as({ actor: "ana", locale: "es" });
  await app.run(items.add, { name: "keep" });
  await expect(app.run(items.add, { name: "boom" })).rejects.toThrow();
  expect((t.db as Store).rows.items).toEqual([{ name: "keep" }]);
  await t.rollback();
});

test("testing: manual jobs wait in queued until drained", async () => {
  const { registry } = setup();
  const services = { log: [] as string[] };
  const t = createTestRegistry(registry, { jobs: "manual", services });
  await t.begin();
  await t.as({ actor: "a", locale: "es" }).run(items.add, { name: "iso" });
  expect(services.log).toEqual([]);
  expect(t.events.length).toEqual(1);
  expect(t.jobs.queued.map((j) => j.listener)).toEqual(["log.onAdded"]);
  await t.jobs.drain();
  expect(services.log).toEqual(["added iso (items.added, es)"]);
  expect(t.jobs.queued).toEqual([]);
  await t.rollback();
});

test("testing: a failing listener makes run throw, so a test can't pass over it", async () => {
  const { registry, services } = setup();
  const t = createTestRegistry(registry);
  await t.begin();
  const app = t.as({ actor: "a", locale: "es" });
  await expect(app.run(items.add, { name: "listener-fails" })).rejects.toThrow("listener exploded");
  expect((t.db as Store).rows.items).toEqual([{ name: "listener-fails" }]); // the mutation committed, as in production
  await app.run(items.add, { name: "fine" }); // the failure was surfaced once, not carried over
  expect(services.log).toEqual(["added fine (items.added, es)"]);
  await t.rollback();
});

test("testing: a listener failure from a call through t.registry fails the test at rollback", async () => {
  const { registry } = setup();
  const t = createTestRegistry(registry);
  await t.begin();
  await t.registry.as({ actor: "a", locale: "es" }).run(items.add, { name: "listener-fails" }); // an adapter's call: not thrown here
  await expect(t.rollback()).rejects.toThrow("listener exploded");
});

test("testing: perform runs one listener by hand, as a scope; drain and perform throw its failure", async () => {
  const { registry, services } = setup();
  const t = createTestRegistry(registry, { jobs: "manual" });
  await t.begin();
  expect(await t.jobs.perform(log.onAdded, { name: "p" }, { scope: { actor: "a", locale: "en" } })).toEqual("done");
  expect(services.log).toEqual(["added p (items.added, en)"]);
  await expect(t.jobs.perform(log.onAdded, { name: "listener-fails" }, { scope: { actor: "a", locale: "en" } })).rejects.toThrow("listener exploded");
  await t.as({ actor: "a", locale: "es" }).run(items.add, { name: "listener-fails" });
  await expect(t.jobs.drain()).rejects.toThrow("listener exploded");
  await t.rollback();
});

test("testing: without begin it says how to set up the hooks; begin twice names concurrency", async () => {
  const { registry } = setup();
  const t = createTestRegistry(registry);
  const app = t.as({ actor: "a", locale: "es" });
  expect(() => app.run(items.list)).toThrow(/No test transaction. Add beforeEach\(\(\) => t.begin\(\)\)/);
  expect(() => t.events).toThrow(/No test transaction/);
  await t.begin();
  await expect(t.begin()).rejects.toThrow(/before t.rollback\(\).*test.concurrent/);
  await t.rollback();
  await t.rollback(); // nothing open: a no-op, so a failed begin doesn't add a second error
});

test("a test registry keeps the app's transactionAttempts, whatever its adapter's nest returns", async () => {
  let calls = 0;
  const db = memoryDatabase();
  const tx = { ...db, retryable: () => true, transaction: async () => { calls++; throw new Error("deadlock detected"); } };
  const database = { ...db, nest: () => tx };
  const t = createTestRegistry(createRegistry<Scope>({ modules: { items, log }, database: { adapter: database, transactionAttempts: 5 }, services: { log: [] } }));
  await t.begin();
  await expect(t.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(5);
  await t.rollback();
});

test("testing: t.jobs.tick runs the crons due at a minute (default: the frozen now), and throws a failure", async () => {
  const { registry, ran } = cronSetup();
  const t = createTestRegistry(registry, { now: "2026-11-23T09:00:00Z" });
  await t.begin();
  await expect(t.jobs.tick()).rejects.toThrow("smtp down"); // reports.broken
  expect(ran).toEqual(["weekly as system"]);
  expect(await t.jobs.tick("2026-11-27T17:00:00Z")).toEqual(["reports.friday"]);
  await t.rollback();
});

test("testing: t.jobs.perform(cron) runs that one cron, due or not, for a minute (default: the frozen now)", async () => {
  const { registry, ran, weekly, broken } = cronSetup();
  const t = createTestRegistry(registry, { now: "2026-11-25T12:34:00Z" }); // a Wednesday: weekly isn't due
  await t.begin();
  expect(await t.jobs.perform(weekly)).toBe("done");
  expect(ran).toEqual(["weekly as system"]); // only this cron, not the others
  await expect(t.jobs.perform(broken, { attempt: 2 })).rejects.toThrow("smtp down");
  expect(() => t.jobs.perform(cron({ schedule: "* * * * *", scope: system, handler: async () => {} }))).toThrow(/cron that isn't registered/);
  expect(() => t.jobs.perform(weekly, { at: "nope" })).toThrow(/needs a valid date/);
  await t.rollback();
});

test("testing: t.registry.jobs.invoke runs the cron inline, like a tick; failures throw, so nothing is kept to list", async () => {
  const { registry, ran, weekly, broken } = cronSetup();
  const t = createTestRegistry(registry, { now: "2026-11-25T12:34:00Z" });
  await t.begin();
  await t.registry.jobs.invoke(weekly);
  expect(ran).toEqual(["weekly as system"]);
  await t.registry.jobs.invoke(broken);
  await expect(t.rollback()).rejects.toThrow("smtp down"); // the failure surfaces at the end of the test
  await t.begin();
  await expect(t.registry.jobs.failed()).rejects.toThrow(/can't list failed jobs/);
  await t.rollback();
});

test("testing: scheduled calls wait in t.jobs.scheduled; drain runs what's due at the test's now, or until a time", async () => {
  const { registry, book, reminded } = scheduleSetup();
  const t = createTestRegistry(registry, { now: "2026-07-01T10:00:00Z" });
  await t.begin();
  await t.as({ actor: "ana", locale: "es" }).run(book, { who: "guest" });
  expect(t.jobs.scheduled.map((j) => [j.fn, j.runAt])).toEqual([["bookings.remind", "2026-07-01T11:00:00.000Z"]]);
  await t.jobs.drain(); // not due yet
  expect(reminded).toEqual([]);
  await t.jobs.drain({ until: "2026-07-01T11:00:00Z" });
  expect(reminded).toEqual(["guest as ana in es"]);
  expect(t.jobs.scheduled).toEqual([]);
  await t.rollback();
});

test("testing: the test registry holds what your adapter holds, so a missing database queue fails in tests too", async () => {
  const { registry: onInProcess, book } = scheduleSetup({ jobs: {} });
  const t = createTestRegistry(onInProcess);
  await t.begin();
  await expect(t.as({ actor: "ana", locale: "es" }).run(book, { who: "guest" })).rejects.toThrow(/can't hold jobs/);
  await t.rollback();
});

test("testing: drain runs each waiting job at the time it was due, so one that reschedules itself moves on and stops", async () => {
  const seen: string[] = [];
  const pulse = action({
    async handler(ctx) {
      seen.push(ctx.now().toISOString().slice(11, 16));
      await ctx.run(rearm);
    },
  });
  const rearm = mutation({ async handler(ctx) { ctx.schedule(pulse, undefined, { delay: 3600 }); } });
  const registry = createRegistry<Scope>({ modules: { x: { pulse, rearm } }, database: { adapter: memoryDatabase() }, jobs: { adapter: { holds: true, async deliver() {} }, scope: { load: (saved) => saved } } });
  const t = createTestRegistry(registry, { now: "2026-07-01T10:00:00Z" });
  await t.begin();
  await t.as({ actor: "a", locale: "es" }).run(rearm);
  await t.jobs.drain({ until: "2026-07-01T13:30:00Z" });
  expect(seen).toEqual(["11:00", "12:00", "13:00"]);
  expect(t.jobs.scheduled.map((j) => j.runAt)).toEqual(["2026-07-01T14:00:00.000Z"]);
  await expect(t.jobs.drain({ until: "garbage" })).rejects.toThrow(/needs a valid date/);
  await t.rollback();
});

test("inProcess() refuses attempts above 1, as it refuses a delay; inline tests try once, so a failure fails the test", async () => {
  const { mutation, event, listener, cron, createRegistry } = init<{ scope: object; db: Store }>();
  const happened = event({ payload: z.object({}) });
  const go = mutation({ async handler(ctx) { ctx.emit(happened, {}); } });
  let tries = 0;
  const flaky = listener({ event: () => happened, attempts: 3, async handler() { tries++; throw new Error("down"); } });
  const nightly = cron({ schedule: "0 3 * * *", scope: {}, attempts: 2, handler: async () => {} });
  const outcomes: (string | undefined)[] = [];
  expect(() => createRegistry({ modules: { x: { happened, go, flaky } }, database: { adapter: memoryDatabase() } })).toThrow(
    /x\.flaky has attempts: 3, but your jobs adapter, inProcess\(\), runs each job once\. Use one that retries/,
  );
  expect(() => createRegistry({ modules: { x: { nightly } }, database: { adapter: memoryDatabase() } })).toThrow(/x\.nightly has attempts: 2, but your jobs adapter, inProcess\(\), runs each job once/);
  const registry = createRegistry({
    modules: { x: { happened, go, flaky } },
    database: { adapter: memoryDatabase() },
    jobs: inline,
    onError: (_error, info) => void outcomes.push(info.outcome),
  });
  const t = createTestRegistry(registry);
  await t.begin();
  await expect(t.as({}).run(go)).rejects.toThrow("down");
  await t.rollback();
  expect(tries).toBe(1);
  expect(outcomes).toEqual(["failed"]);
});
