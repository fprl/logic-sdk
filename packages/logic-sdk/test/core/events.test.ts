// Events and listeners: after commit, as the emitter's scope, plain JSON, `when`, loops.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, type Envelope, type Job, type JobsAdapter } from "../../src/index.ts";
import { createTestRegistry } from "../../src/testing.ts";
import { add, deliveriesIn, event, items, listener, log, mutation, reg, regSetup, setup, stampedSeen, type Scope } from "../support/app.ts";
import { memoryDatabase } from "../support/memory-db.ts";

const unhandled: unknown[] = [];
const g = globalThis as any;
if (g.process?.on) g.process.on("unhandledRejection", (e: unknown) => unhandled.push(e));
else g.addEventListener?.("unhandledrejection", (ev: any) => { ev.preventDefault?.(); unhandled.push(ev.reason); });
const tick = () => new Promise((r) => setTimeout(r, 20));

test("mutation commits, then listeners run with the emitter's scope", async () => {
  const { app, services, db } = setup();
  expect(await app.run(items.add, { name: "x" })).toEqual({ name: "x" });
  expect(db.store.rows.items).toEqual([{ name: "x" }]);
  expect(services.log).toEqual(["added x (items.added, es)"]);
});

test("listener failure never fails the caller; goes to onError", async () => {
  const errors: string[] = [];
  const { app, db } = setup({ onError: (e, info) => errors.push(`${info.source}: ${(e as Error).message}`) });
  await app.run(items.add, { name: "listener-fails" });
  expect(db.store.rows.items).toEqual([{ name: "listener-fails" }]);
  expect(errors).toEqual(["log.onAdded: listener exploded"]);
});

test("waitUntil, set once on the registry: run returns after commit, listeners finish later", async () => {
  const later: Promise<unknown>[] = [];
  const { app, services } = setup({ waitUntil: (p) => void later.push(p) });
  await app.run(items.add, { name: "w" });
  expect(later.length).toEqual(1);
  await Promise.all(later);
  expect(services.log).toEqual(["added w (items.added, es)"]);
});

test("run options: events emitted by the callee carry its scope; the caller's own events don't", async () => {
  const emits = mutation({
    input: z.object({ name: z.string() }),
    async handler({ run, scope }, { name }) {
      return run(add, { name }, { scope: { ...scope, actor: "system" } });
    },
  });
  const seen: Envelope[] = [];
  const r = createRegistry<Scope>({
    modules: { items, log, x: { emits } },
    database: { adapter: memoryDatabase() },
    services: { log: [] },
    jobs: { adapter: { deliver: async (jobs) => void seen.push(...jobs.flatMap((d) => (d.kind === "delivery" ? [d.envelope] : []))) }, scope: { load: (_ctx, saved) => saved } },
  });
  await r.as({ actor: "ana", locale: "es" }).run(emits, { name: "z" });
  expect(seen.map((e) => e.scope)).toEqual([{ actor: "system", locale: "es" }]);
});

test("invalid emit + throw rejects cleanly, no unhandled rejection", async () => {
  const { app } = regSetup();
  await expect(app.run(reg.badEmitThenThrow, {})).rejects.toMatchObject({ code: "reg.boom" });
  await tick();
  expect(unhandled.length).toEqual(0);
});

test("errors after commit never reach the caller (throwing onError, throwing waitUntil)", async () => {
  const { app, db } = regSetup({ onError: () => { throw new Error("onError exploded"); } });
  const quiet = console.error; console.error = () => {};
  try {
    expect(await app.run(add, { name: "listener-fails" })).toEqual({ name: "listener-fails" });
    const { app: app2 } = regSetup({ waitUntil: () => { throw new TypeError("Illegal invocation"); } });
    expect(await app2.run(add, { name: "w" })).toEqual({ name: "w" });
  } finally { console.error = quiet; }
  expect(db.store.rows.items).toEqual([{ name: "listener-fails" }]);
});

test("emit takes the schema's input, listeners get its output", async () => {
  const { app } = regSetup();
  stampedSeen.length = 0;
  await app.run(reg.stamp, { at: "2026-07-01T00:00:00Z" });
  expect(stampedSeen[0]!.at instanceof Date).toBe(true);
});

test("listener: attempts is a whole number of tries, delay is seconds", () => {
  const happened = event({ payload: z.object({}) });
  expect(() => listener({ event: () => happened, attempts: 0, async handler() {} })).toThrow(/attempts must be a whole number of tries, 1 or more \(got 0\)/);
  expect(() => listener({ event: () => happened, attempts: 2.5, async handler() {} })).toThrow(/attempts/);
  expect(() => listener({ event: () => happened, delay: -1, async handler() {} })).toThrow(/delay must be seconds, 0 or more \(got -1\)/);
});

test("emit takes plain JSON only, so what works in-process works through a queue", async () => {
  const at = event({ payload: z.object({ at: z.any() }) });
  const emitDate = mutation({ handler: async (ctx) => ctx.emit(at, { at: new Date() }) });
  const emitString = mutation({ handler: async (ctx) => ctx.emit(at, { at: "2026-07-01T00:00:00Z" }) });
  const r = createRegistry<Scope>({ modules: { x: { at, emitDate, emitString } }, database: { adapter: memoryDatabase() } });
  await expect(r.as({ actor: "a", locale: "es" }).run(emitDate)).rejects.toThrow(/x\.at payload isn't plain data at at: a Date/);
  await expect(r.as({ actor: "a", locale: "es", when: new Date() } as Scope).run(emitString)).rejects.toThrow(/scope emitting x\.at isn't plain data at when: a Date/);
  await r.as({ actor: "a", locale: "es" }).run(emitString);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  const emitLoop = mutation({ handler: async (ctx) => ctx.emit(at, { at: loop }) });
  const shared = { a: 1 };
  const emitShared = mutation({ handler: async (ctx) => ctx.emit(at, { at: [shared, shared] }) }); // shared isn't circular
  const r2 = createRegistry<Scope>({ modules: { x: { at, emitLoop, emitShared } }, database: { adapter: memoryDatabase() } });
  await expect(r2.as({ actor: "a", locale: "es" }).run(emitLoop)).rejects.toThrow(/at at\.self: a circular reference/);
  await r2.as({ actor: "a", locale: "es" }).run(emitShared);
});

test("listeners see the event without a scope: ctx.scope is the one they run as", async () => {
  const happened = event({ payload: z.object({}) });
  const doIt = mutation({ handler: async (ctx) => ctx.emit(happened, {}) });
  let seen: object | undefined;
  const look = listener({ event: () => happened, async handler(ctx) { seen = ctx.event; } });
  await createRegistry<Scope>({ modules: { x: { happened, doIt, look } }, database: { adapter: memoryDatabase() } }).as({ actor: "a", locale: "es" }).run(doIt);
  expect(seen).toMatchObject({ id: expect.any(String), name: "x.happened", payload: {}, attempt: 1 });
  expect(seen).not.toHaveProperty("scope");
});

test("listener loops stop at maxEventDepth (default 8 hops) and are reported once, not thrown", async () => {
  const ping = event({ payload: z.object({ n: z.number() }) });
  const bump = mutation({ input: z.object({ n: z.number() }), handler: async ({ emit }, { n }) => emit(ping, { n }) });
  const hops: number[] = [];
  const loop = listener({ event: () => ping, handler: async ({ run }, { n }) => { hops.push(n); await run(bump, { n: n + 1 }); } });
  for (const [maxEventDepth, expected] of [[undefined, 8], [5, 5]] as const) {
    hops.length = 0;
    const errors: string[] = [];
    const d = createRegistry<Scope>({ modules: { l: { ping, bump, loop } }, database: { adapter: memoryDatabase() }, jobs: { maxEventDepth }, onError: (e, { source }) => errors.push(`${source}: ${(e as Error).message}`) });
    await d.as({ actor: "a", locale: "es" }).run(bump, { n: 0 });
    expect(hops.length).toEqual(expected);
    expect(errors).toEqual([expect.stringMatching(new RegExp(`^l\\.ping: .*deeper than ${expected}`))]);
  }
});

test("emit snapshots the payload: mutating it afterwards changes nothing", async () => {
  const got: string[] = [];
  const happened = event({ payload: z.object({ name: z.string() }) });
  const doIt = mutation({ input: z.object({}), async handler({ emit }) {
    const payload = { name: "before" };
    emit(happened, payload);
    payload.name = "after";
  } });
  const listen = listener({ event: () => happened, handler: async (_, { name }) => { got.push(name); } });
  await createRegistry<Scope>({ modules: { x: { happened, doIt, listen } }, database: { adapter: memoryDatabase() } }).as({ actor: "a", locale: "es" }).run(doIt, {});
  expect(got).toEqual(["before"]);
});

test("emit returns the event it queued: the id, name and time its listeners see, and t.events has", async () => {
  const seen: unknown[] = [];
  const commented = event({ payload: z.object({ taskId: z.string(), n: z.coerce.number() }) });
  const comment = mutation({
    input: z.object({ taskId: z.string() }),
    async handler(ctx, { taskId }) {
      const queued = ctx.emit(commented, { taskId, n: 1 });
      seen.push(queued);
      expect(Object.isFrozen(queued)).toBe(true);
      (queued.payload as { taskId: string }).taskId = "changed"; // a copy: what's delivered stays as emitted
      return queued.id;
    },
  });
  const notify = listener({ event: () => commented, async handler(ctx) { seen.push(ctx.event); } });
  const registry = createRegistry<Scope>({ modules: { tasks: { commented, comment, notify } }, database: { adapter: memoryDatabase() } });
  const t = createTestRegistry(registry);
  await t.begin();
  const id = await t.as({ actor: "ana", locale: "es" }).run(comment, { taskId: "t1" });
  const [queued, delivered] = seen as [{ id: string; name: string; occurredAt: string }, { id: string; name: string; occurredAt: string; payload: unknown }];
  expect(queued).toMatchObject({ id, name: "tasks.commented", payload: { taskId: "changed", n: 1 } });
  expect(delivered).toMatchObject({ id, name: "tasks.commented", occurredAt: queued.occurredAt, payload: { taskId: "t1", n: 1 } });
  expect(t.events.map((e) => e.id)).toEqual([id]);
  await t.rollback();
});

test("listener `when`: false, and the event gets no job for it; it sees the parsed payload; a throw fails the mutation", async () => {
  const placed = event({ payload: z.object({ total: z.number(), currency: z.string().default("EUR") }) });
  const place = mutation({
    input: z.object({ total: z.number() }),
    async handler({ db, emit }, { total }) {
      (db.rows.orders ??= []).push({ total });
      emit(placed, { total });
    },
  });
  const seen: unknown[] = [];
  const ran: number[] = [];
  const fraud = listener({
    event: () => placed,
    when: (order) => {
      seen.push(order);
      if (order.total < 0) throw new Error("a bug in when");
      return order.total > 5000;
    },
    async handler(_ctx, order) { ran.push(order.total); },
  });
  const always = listener({ event: () => placed, async handler() {} });
  const modules = { o: { placed, place, fraud, always } };
  const scope = { actor: "a", locale: "es" };

  // a custom adapter sees exactly the jobs made: none for fraud on a small order
  const enqueued: Job[] = [];
  const adapter: JobsAdapter = { async enqueue(_tx, jobs) { enqueued.push(...jobs); }, async deliver() {} };
  const queued = createRegistry<Scope>({ modules, database: { adapter: memoryDatabase() }, services: { log: [] }, jobs: { adapter, scope: { load: (_ctx, s) => s } } });
  await queued.as(scope).run(place, { total: 100 });
  await queued.as(scope).run(place, { total: 9000 });
  expect(deliveriesIn(enqueued).map((d) => `${d.listener} ${(d.envelope.payload as { total: number }).total}`)).toEqual(["o.always 100", "o.fraud 9000", "o.always 9000"]);
  expect(seen).toEqual([{ total: 100, currency: "EUR" }, { total: 9000, currency: "EUR" }]); // parsed: the default is there

  // inProcess: it doesn't run; a throw fails the mutation and rolls it back
  const database = memoryDatabase();
  const app = createRegistry<Scope>({ modules, database: { adapter: database }, services: { log: [] } }).as(scope);
  await app.run(place, { total: 100 });
  await app.run(place, { total: 9000 });
  expect(ran).toEqual([9000]);
  await expect(app.run(place, { total: -1 })).rejects.toThrow("[logic-sdk] o.fraud's when threw on o.placed: a bug in when");
  expect(database.store.rows.orders).toEqual([{ total: 100 }, { total: 9000 }]);

  // the test registry: no queued job for it; perform, which names the listener, skips `when`
  const t = createTestRegistry(createRegistry<Scope>({ modules, database: { adapter: memoryDatabase() }, services: { log: [] } }), { jobs: "manual" });
  await t.begin();
  await t.as(scope).run(place, { total: 100 });
  expect(t.jobs.queued.map((d) => d.listener)).toEqual(["o.always"]);
  ran.length = 0;
  expect(await t.jobs.perform(fraud, { total: 100, currency: "EUR" }, { scope })).toEqual("done");
  expect(ran).toEqual([100]);
  await t.rollback();
});
