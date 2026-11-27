// ctx.schedule: a call committed with the mutation, held by the adapter, run as its stored scope.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, type Call, type Job } from "../../src/index.ts";
import { createTestRegistry } from "../../src/testing.ts";
import { action, event, listener, mutation, scheduleSetup, type Scope } from "../support/app.ts";
import { memoryDatabase } from "../support/memory-db.ts";

test("ctx.schedule: a job committed with the mutation, as the caller's scope, for the adapter to hold", async () => {
  const { app, book, sent } = scheduleSetup();
  expect(await app.run(book, { who: "guest" })).toBeUndefined(); // nothing to keep: ctx.schedule returns nothing
  expect(sent).toEqual([
    {
      kind: "call",
      attempts: 1,
      depth: 0,
      id: expect.stringMatching(/^bookings\.remind@[0-9a-f-]{36}$/),
      fn: "bookings.remind",
      input: { who: "guest" },
      scope: { actor: "ana", locale: "es" },
      runAt: "2026-07-01T11:00:00.000Z",
    },
  ]);
  await expect(app.run(book, { who: "x", fail: true })).rejects.toMatchObject({ kind: "rejected" });
  expect(sent).toHaveLength(1); // rolled back: nothing scheduled
  await app.run(book, { who: "y", at: "2026-07-02T09:00:00Z" });
  expect(sent[1]).toMatchObject({ runAt: "2026-07-02T09:00:00.000Z" });
});

test("ctx.schedule: refused where nothing can hold it (in-process), or for longer than the adapter can", async () => {
  const { app, book } = scheduleSetup({ jobs: {} });
  await expect(app.run(book, { who: "guest" })).rejects.toThrow(/ctx\.schedule\(bookings\.remind\) waits 3600s, but your jobs adapter, inProcess\(\), can't hold jobs/);
  const short = scheduleSetup({ jobs: { adapter: { holds: { max: 60 }, async deliver() {} }, scope: { load: (_ctx, saved) => saved } } });
  await expect(short.app.run(short.book, { who: "guest" })).rejects.toThrow(/holds jobs for at most 60s/);
  await expect(short.app.run(short.book, { who: "guest", at: "not a date" })).rejects.toThrow(/needs an `at` date or a `delay`/);
});

test("ctx.schedule: the job runs its function as the stored scope, loaded fresh; a rule saying no fails it", async () => {
  const { app, book, reminded, registry } = scheduleSetup({
    onError: () => {},
    jobs: {
      adapter: { holds: true, async deliver() {} },
      scope: { load: (_ctx: unknown, saved: { actor: string | null }) => ({ actor: saved.actor, locale: "en" }) }, // today's settings
    },
  });
  const run = (job: Job) => registry.jobs.run(job);
  await app.run(book, { who: "guest" });
  const job = { kind: "call" as const, attempts: 1, depth: 0, id: "bookings.remind@1", fn: "bookings.remind", input: { who: "guest" }, scope: { actor: "ana" } };
  expect(await run(job)).toBe("done");
  expect(reminded).toEqual(["guest as ana in en"]); // load rebuilt the locale
  expect(await run({ ...job, input: { who: "nobody" } })).toBe("failed"); // not_found: no retry
  expect(await run({ ...job, fn: "bookings.gone" })).toBe("failed"); // renamed or removed: kept for retry
});

test("ctx.schedule: due now runs after commit like a listener; a negative delay or a bad input is a bug", async () => {
  const ran: string[] = [];
  const ping = action({ input: z.object({ n: z.number() }), async handler(_ctx, { n }) { ran.push(`ping ${n}`); } });
  const go = mutation({
    input: z.object({ delay: z.number(), n: z.any() }),
    async handler(ctx, { delay, n }) { ctx.schedule(ping, { n }, { delay }); },
  });
  const app = createRegistry<Scope>({ modules: { x: { ping, go } }, database: { adapter: memoryDatabase() } }).as({ actor: "a", locale: "es" });
  await app.run(go, { delay: 0, n: 1 }); // in-process can't hold, but nothing waits
  expect(ran).toEqual(["ping 1"]);
  await expect(app.run(go, { delay: -5, n: 1 })).rejects.toThrow(/needs an `at` date or a `delay` in seconds, 0 or more/);
  await expect(app.run(go, { delay: 0, n: "one" })).rejects.toThrow(/x\.ping input is invalid/);
});

test("ctx.schedule: attempts are stamped on the job; an action that fails retries while it has tries left", async () => {
  let calls = 0;
  const charge = action({ async handler() { calls++; throw new Error("timeout"); } });
  const go = mutation({
    input: z.object({ attempts: z.number().optional() }),
    async handler(ctx, { attempts }) { ctx.schedule(charge, undefined, { delay: 60, attempts }); },
  });
  const sent: Job[] = [];
  const registry = createRegistry<Scope>({
    modules: { x: { charge, go } },
    database: { adapter: memoryDatabase() },
    onError: () => {},
    jobs: { adapter: { holds: true, retries: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (_ctx, saved) => saved } },
  });
  const app = registry.as({ actor: "a", locale: "es" });
  await app.run(go, { attempts: 3 });
  await app.run(go, {});
  const [three, one] = sent;
  expect([three!.attempts, one!.attempts]).toEqual([3, 1]);
  await expect(registry.jobs.run(three!, { attempt: 2 })).rejects.toThrow("timeout"); // a try left: the queue redelivers
  expect(await registry.jobs.run(three!, { attempt: 3 })).toBe("failed");
  expect(await registry.jobs.run(one!)).toBe("failed"); // the default: one try
  expect(calls).toBe(3);
  await expect(app.run(go, { attempts: 0 })).rejects.toThrow(/ctx\.schedule\(x\.charge\) attempts must be a whole number of tries, 1 or more \(got 0\)/);
});

test("ctx.schedule: a function that schedules itself with no delay stops at maxEventDepth, like a listener loop", async () => {
  const errors: string[] = [];
  let runs = 0;
  const again: ReturnType<typeof mutation> = mutation({ async handler(ctx) { runs++; ctx.schedule(again, undefined, { delay: 0 }); } });
  const r = createRegistry<Scope>({ modules: { x: { again } }, database: { adapter: memoryDatabase() }, jobs: { maxEventDepth: 4 }, onError: (e) => errors.push((e as Error).message) });
  await r.as({ actor: "a", locale: "es" }).run(again);
  expect(runs).toBe(5); // the caller's run, then 4 hops
  expect(errors).toEqual([expect.stringMatching(/chain of events and calls deeper than 4/)]);
});

test("ctx.schedule: events and calls share one chain, and a real delay starts a new one", async () => {
  const pinged = event({ payload: z.object({}) });
  const ping = mutation({ async handler(ctx) { ctx.emit(pinged, {}); } });
  const errors: string[] = [];
  let runs = 0;
  const pong = listener({ event: () => pinged, async handler(ctx) { runs++; await ctx.run(serve); } });
  const serve = mutation({ async handler(ctx) { ctx.schedule(ping, undefined, { delay: 0 }); } });
  const r = createRegistry<Scope>({ modules: { x: { pinged, ping, pong, serve } }, database: { adapter: memoryDatabase() }, jobs: { maxEventDepth: 6 }, onError: (e) => errors.push((e as Error).message) });
  await r.as({ actor: "a", locale: "es" }).run(ping);
  expect(runs).toBe(3); // event (1), call (2), event (3), call (4), event (5), call (6), event (7): stopped
  expect(errors).toEqual([expect.stringMatching(/deeper than 6/)]);

  // a commit past the limit drops what's too deep, not a call that waits: that one starts a new chain
  const held: Job[] = [];
  const deep = mutation({ async handler(ctx) { ctx.emit(pinged, {}); ctx.schedule(ping, undefined, { delay: 60 }); } });
  const r2 = createRegistry<Scope>({
    modules: { x: { pinged, ping, deep } },
    database: { adapter: memoryDatabase() },
    onError: () => {},
    jobs: { adapter: { holds: true, async deliver(jobs) { held.push(...jobs); } }, scope: { load: (_ctx, saved) => saved }, maxEventDepth: 0 },
  });
  await r2.as({ actor: "a", locale: "es" }).run(deep);
  expect(held).toMatchObject([{ kind: "call", depth: 0 }]);

  const sent: Job[] = [];
  const later = mutation({ async handler(ctx) { ctx.schedule(ping, undefined, { delay: 60 }); } });
  const waits = createRegistry<Scope>({
    modules: { x: { pinged, ping, later } },
    database: { adapter: memoryDatabase() },
    jobs: { adapter: { holds: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (_ctx, saved) => saved } },
  });
  await waits.as({ actor: "a", locale: "es" }).run(later);
  expect(sent).toMatchObject([{ kind: "call", depth: 0 }]); // waiting a minute is a new chain, not a loop
});

test("ctx.schedule takes a scope, whole, to run as; wrap's call says which job and which try", async () => {
  const sent: Job[] = [];
  const calls: Call[] = [];
  const remind = action({ input: z.object({ who: z.string() }), async handler() {} });
  const book = mutation({
    input: z.object({}),
    async handler(ctx) {
      ctx.schedule(remind, { who: "guest" }, { delay: 60, attempts: 2, scope: { actor: "system", locale: "en" } });
    },
  });
  const registry = createRegistry<Scope>({
    modules: { b: { remind, book } },
    database: { adapter: memoryDatabase() },
    wrap: (call, next) => (calls.push(call), next()),
    jobs: { adapter: { holds: true, retries: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (_ctx, saved) => saved } },
  });
  await registry.as({ actor: "ana", locale: "es" }).run(book, {});
  expect(sent[0]).toMatchObject({ kind: "call", fn: "b.remind", scope: { actor: "system", locale: "en" } });
  expect(calls.map((c) => c.job)).toEqual([undefined]); // a call from outside isn't a job
  calls.length = 0;
  await registry.jobs.run(sent[0]!, { attempt: 2 });
  expect(calls.map((c) => [c.id, c.scope, c.job])).toEqual([["b.remind", { actor: "system", locale: "en" }, { id: sent[0]!.id, attempt: 2 }]]);
});

test("ctx.schedule replace: in tests too, a newer call to the function with the same input replaces the one waiting", async () => {
  const sent: string[] = [];
  const remind = action({ input: z.object({ bookingId: z.string() }), async handler(_ctx, { bookingId }) { sent.push(bookingId); } });
  const book = mutation({
    input: z.object({ bookingId: z.string(), delay: z.number(), twice: z.boolean().optional() }),
    async handler(ctx, { bookingId, delay, twice }) {
      if (twice) ctx.schedule(remind, { bookingId }, { delay: 60, replace: true }); // the later one in this transaction wins
      ctx.schedule(remind, { bookingId }, { delay, replace: true });
    },
  });
  const replacing = { holds: true as const, replaces: true as const, async deliver() {} };
  const registry = createRegistry<Scope>({ modules: { x: { remind, book } }, database: { adapter: memoryDatabase() }, jobs: { adapter: replacing, scope: { load: (_ctx, saved) => saved } } });
  const t = createTestRegistry(registry, { now: "2026-07-01T10:00:00Z" });
  await t.begin();
  const app = t.as({ actor: "ana", locale: "es" });
  await app.run(book, { bookingId: "b1", delay: 3600, twice: true });
  await app.run(book, { bookingId: "b1", delay: 7200 }); // the dates changed
  await app.run(book, { bookingId: "b2", delay: 3600 }); // another input: its own call
  expect(t.jobs.scheduled.map((j) => [j.input, j.runAt])).toEqual([
    [{ bookingId: "b1" }, "2026-07-01T12:00:00.000Z"],
    [{ bookingId: "b2" }, "2026-07-01T11:00:00.000Z"],
  ]);
  await t.jobs.drain({ until: "2026-07-02T00:00:00Z" });
  expect(sent).toEqual(["b2", "b1"]);
  await t.rollback();
});

test("ctx.schedule replace: refused where nothing can replace (in-process)", async () => {
  const ping = action({ async handler() {} });
  const go = mutation({
    async handler(ctx) {
      ctx.schedule(ping, undefined, { delay: 0, replace: true });
    },
  });
  const app = createRegistry<Scope>({ modules: { x: { ping, go } }, database: { adapter: memoryDatabase() } }).as({ actor: "a", locale: "es" });
  await expect(app.run(go)).rejects.toThrow(/inProcess\(\), can't replace one it already has\. Use one that can/);
});
