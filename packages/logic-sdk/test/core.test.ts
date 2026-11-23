import { z } from "zod";
import {
  createRegistry, init, inProcess, isDomainError, type Call, type Delivery, type JobsAdapter, type Job, type DomainError, type Envelope, type FailureInfo,
} from "../src/index.ts";
import { createTestRegistry } from "../src/testing.ts";
import { expect, test } from "bun:test";
import { memoryDatabase, type Store } from "./memory-db.ts";

const deliveriesIn = (jobs: Job[]) => jobs.filter((j): j is Delivery => j.kind === "delivery");

type Scope = { actor: string | null; locale: string };
const { query, mutation, action, event, listener, cron } = init<{ scope: Scope; db: Store; services: { log: string[] } }>();
const anyone = () => true;
const signedIn = (s: Scope): s is Scope & { actor: string } => s.actor !== null;

// ── a tiny two-module registry (separate consts, like real module files) ─────
const added = event({ payload: z.object({ name: z.string() }) });

const list = query({
  input: z.object({}).optional(),
  authorize: anyone,
  expose: true,
  output: z.array(z.string()),
  handler: async ({ db }) => (db.rows.items ?? []).map((r) => r.name as string),
});
const add = mutation({
  input: z.object({ name: z.string().min(1) }),
  authorize: signedIn,
  expose: true,
  output: z.object({ name: z.string() }),
  async handler({ db, emit, errors, scope }, { name }) {
    const actor: string = scope.actor; // narrowed by the policy
    if (name === "boom") throw errors.reject("boom");
    void actor;
    (db.rows.items ??= []).push({ name });
    emit(added, { name });
    return { name };
  },
});
const addTwo = mutation({
  input: z.object({ a: z.string(), b: z.string() }),
  async handler({ run }, { a, b }) {
    await run(add, { name: a });
    try { await run(add, { name: b }); } catch { /* caught, but the transaction is doomed */ }
    return "done";
  },
});
const typed = mutation({
  input: z.object({ n: z.number() }),
  output: z.object({ doubled: z.number().max(10) }),
  handler: async (_, { n }) => ({ doubled: n * 2 }),
});
const locale = query({ handler: async ({ scope }) => scope.locale });
const whoami = query({
  handler: async ({ scope, run }) => ({
    outer: scope.locale,
    inner: await run(locale, undefined, { scope: { locale: "en" } }),
    nested: await run(locale),
  }),
});
const greet = action({
  input: z.object({ name: z.string() }),
  async handler({ run, services }, { name }) {
    services.log.push(`greet ${name}`);
    return run(add, { name });
  },
});
const items = { added, list, add, addTwo, typed, locale, whoami, greet };

const onAdded = listener({ event: () => added, handler: async ({ services, event, scope }, { name }) => {
  if (name === "listener-fails") throw new Error("listener exploded");
  services.log.push(`added ${name} (${event.name}, ${scope.locale})`);
} });
const log = { onAdded };

function setup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const db = memoryDatabase();
  const services = { log: [] as string[] };
  const registry = createRegistry<Scope>({ modules: { items, log }, database: db, services, ...extra });
  const app = registry.as({ actor: "ana", locale: "es" });
  return { db, services, registry, app };
}

// ── tests ────────────────────────────────────────────────────────────────────
test("registry: ids come from module keys", () => {
  const { registry } = setup();
  expect(registry.definitions.functions.map((f) => f.id).sort()).toEqual([
    "items.add", "items.addTwo", "items.greet", "items.list", "items.locale", "items.typed", "items.whoami",
  ]);
  expect(registry.definitions.listeners.map((l) => l.id)).toEqual(["log.onAdded"]);
  expect(registry.definitions.functions.filter((f) => f.exposed).map((f) => f.id).sort()).toEqual(["items.add", "items.list"]);
});

test("mutation commits, then listeners run with the emitter's scope", async () => {
  const { app, services, db } = setup();
  expect(await app.run(items.add, { name: "x" })).toEqual({ name: "x" });
  expect(db.store.rows.items).toEqual([{ name: "x" }]);
  expect(services.log).toEqual(["added x (items.added, es)"]);
});

test("failed mutation: nothing written, no events", async () => {
  const { app, services, db } = setup();
  await expect(app.run(items.add, { name: "boom" })).rejects.toMatchObject({ code: "items.boom" });
  expect(db.store.rows.items).toEqual(undefined);
  expect(services.log).toEqual([]);
});

test("a nested failure dooms the transaction even when caught", async () => {
  const { app, services, db } = setup();
  await expect(app.run(items.addTwo, { a: "ok", b: "boom" })).rejects.toMatchObject({ code: "items.boom" });
  expect(db.store.rows.items).toEqual(undefined);
  expect(services.log).toEqual([]);
});

test("no input: run(fn), and whatever an adapter sends is ignored", async () => {
  const { app } = setup();
  expect(await app.run(items.locale)).toBe("es");
  expect(await app.run(items.locale, {} as never)).toBe("es"); // an AI tool sends {}
});

test("invalid input → DomainError kind invalid, with issues", async () => {
  const { app } = setup();
  // @ts-expect-error wrong input type
  await expect(app.run(items.add, { name: 1 })).rejects.toMatchObject({ kind: "invalid", code: "items.add.invalid_input" });
});

test("an exposed function's check runs on every call, nested ones too", async () => {
  const { registry, db } = setup();
  const anon = registry.as({ actor: null, locale: "es" });
  await expect(anon.run(items.add, { name: "x" })).rejects.toMatchObject({ kind: "forbidden", code: "items.add.forbidden" });
  // greet is internal (no check), but the add it runs is exposed: still checked, so a narrowed scope never lies
  await expect(anon.run(items.greet, { name: "y" })).rejects.toMatchObject({ kind: "forbidden" });
  expect(db.store.rows.items).toEqual(undefined);
});

test("run options: { scope } changes who is calling for that call, and checks see it", async () => {
  const asAdmin = action({
    input: z.object({ name: z.string() }),
    handler: async ({ run }, { name }) => run(add, { name }, { scope: { actor: "system" } }),
  });
  const r = createRegistry<Scope>({ modules: { items, log, x: { asAdmin } }, database: memoryDatabase(), services: { log: [] } });
  expect(await r.as({ actor: null, locale: "es" }).run(asAdmin, { name: "z" })).toEqual({ name: "z" });
});

test("expose: true without authorize or output fails at createRegistry, naming the function", () => {
  const msg = (fn: object) => { try { createRegistry<Scope>({ modules: { orders: { fn } }, database: memoryDatabase() }); return ""; } catch (e) { return (e as Error).message; } };
  // @ts-expect-error expose without authorize
  expect(msg(query({ output: z.number(), expose: true, handler: async () => 1 }))).toMatch(/orders\.fn has expose: true but no authorize/);
  // @ts-expect-error expose without output
  expect(msg(query({ authorize: anyone, expose: true, handler: async () => 1 }))).toMatch(/orders\.fn has expose: true but no output/);
});

test("a policy must return exactly true: truthy or a Promise is a denial", async () => {
  const truthy = query({ authorize: (() => "yes") as any, handler: async () => 1 });
  const asyncy = query({ authorize: (async () => true) as any, handler: async () => 1 });
  const r = createRegistry<Scope>({ modules: { p: { truthy, asyncy } }, database: memoryDatabase() });
  const app = r.as({ actor: "a", locale: "es" });
  await expect(app.run(truthy)).rejects.toMatchObject({ kind: "forbidden", code: "p.truthy.forbidden" });
  await expect(app.run(asyncy)).rejects.toMatchObject({ kind: "forbidden", code: "p.asyncy.forbidden" });
});

test("an internal function with authorize is checked too, even when your own code runs it", async () => {
  const purge = mutation({ input: z.object({}), authorize: signedIn, handler: async () => "purged" });
  const job = action({ input: z.object({}), handler: async ({ run }) => run(purge, {}) });
  const r = createRegistry<Scope>({ modules: { j: { purge, job } }, database: memoryDatabase(), services: { log: [] } });
  expect(r.definitions.functions.find((f) => f.id === "j.purge")!.exposed).toBe(false);
  await expect(r.as({ actor: null, locale: "es" }).run(job, {})).rejects.toMatchObject({ kind: "forbidden", code: "j.purge.forbidden" });
  expect(await r.as({ actor: "a", locale: "es" }).run(job, {})).toEqual("purged");
});

test("bad input on a nested run is a bug in your code (plain Error), not the caller's 400", async () => {
  const outer = mutation({ input: z.object({}), handler: async ({ run }) => run(add, { name: "" }) });
  const r = createRegistry<Scope>({ modules: { items, log, o: { outer } }, database: memoryDatabase(), services: { log: [] } });
  const err = await r.as({ actor: "a", locale: "es" }).run(outer, {}).catch((e: unknown) => e);
  expect(isDomainError(err)).toBe(false);
  expect(err).toHaveProperty("message", expect.stringMatching(/items\.add was run with invalid input/));
});

test("output schema is enforced", async () => {
  const { app } = setup();
  expect(await app.run(items.typed, { n: 2 })).toEqual({ doubled: 4 });
  // invalid output is a bug in our code, not a bad request: a plain Error (→ 500), never a DomainError (→ 400)
  const err = await app.run(items.typed, { n: 50 }).catch((e: unknown) => e);
  expect(isDomainError(err)).toBe(false);
  expect(err).toHaveProperty("message", expect.stringMatching(/items\.typed output is invalid/));
});

test("scope: nested calls inherit it, a run's { scope } overrides it for that call only", async () => {
  const { app } = setup();
  expect(await app.run(items.whoami)).toEqual({ outer: "es", inner: "en", nested: "es" });
  expect(await app.run(items.locale, undefined, { scope: { locale: "fr" } })).toEqual("fr");
  expect(await app.run(items.locale)).toEqual("es");
});

test("kinds: a query can't run a mutation (runtime guard behind the type)", async () => {
  const { app } = setup();
  const bad = query({
    // @ts-expect-error queries can only run queries
    handler: async ({ run }) => run(items.add, { name: "x" }),
  });
  const d = createRegistry<Scope>({ modules: { items, bad: { bad } }, database: memoryDatabase() });
  await expect(d.as({ actor: "a", locale: "es" }).run(bad)).rejects.toThrow(/is a mutation/);
  void app;
});

test("action: services available, each mutation commits on its own, so a later failure keeps the earlier ones", async () => {
  const { app, services, db } = setup();
  await app.run(items.greet, { name: "z" });
  expect(services.log).toEqual(["greet z", "added z (items.added, es)"]);
  expect(db.store.rows.items).toEqual([{ name: "z" }]);

  const twoSteps = action({
    async handler({ run }) {
      await run(add, { name: "first" });
      await run(add, { name: "boom" }); // fails: an action has no transaction to roll the first one back
    },
  });
  const own = memoryDatabase();
  const r = createRegistry<Scope>({ modules: { items, log, x: { twoSteps } }, database: own, services: { log: [] } });
  await expect(r.as({ actor: "a", locale: "es" }).run(twoSteps)).rejects.toMatchObject({ code: "items.boom" });
  expect(own.store.rows.items).toEqual([{ name: "first" }]);
});

test("output strips keys the schema doesn't name, so a returned row can't leak a column", async () => {
  const row = { name: "a", passwordHash: "x" }; // what a select * returns
  const leaky = query({ output: z.object({ name: z.string() }), handler: async () => row });
  const r = createRegistry<Scope>({ modules: { x: { leaky } }, database: memoryDatabase() });
  expect(await r.as({ actor: "a", locale: "es" }).run(leaky)).toEqual({ name: "a" });
});

test("listener failure never fails the caller; goes to onError", async () => {
  const errors: string[] = [];
  const { app, db } = setup({ onError: (e, info) => errors.push(`${info.source}: ${(e as Error).message}`) });
  await app.run(items.add, { name: "listener-fails" });
  expect(db.store.rows.items).toEqual([{ name: "listener-fails" }]);
  expect(errors).toEqual(["log.onAdded: listener exploded"]);
});

test("an adapter that can't take the jobs: each is reported with the job itself, and the caller still succeeds", async () => {
  const reported: FailureInfo[] = [];
  const { app } = setup({
    onError: (_e, info) => void reported.push(info),
    jobs: { adapter: { deliver: async () => { throw new Error("queue down"); } }, scope: { load: (saved) => saved } },
  });
  expect(await app.run(items.add, { name: "q" })).toBeDefined();
  expect(reported).toEqual([expect.objectContaining({ source: "(jobs adapter)", job: expect.objectContaining({ kind: "delivery", listener: "log.onAdded" }) })]);
});

test("waitUntil, set once on the registry: run returns after commit, listeners finish later", async () => {
  const later: Promise<unknown>[] = [];
  const { app, services } = setup({ waitUntil: (p) => void later.push(p) });
  await app.run(items.add, { name: "w" });
  expect(later.length).toEqual(1);
  await Promise.all(later);
  expect(services.log).toEqual(["added w (items.added, es)"]);
});

test("wrap sees every call with depth", async () => {
  const calls: string[] = [];
  const { app } = setup({ wrap: async (c: Call, next) => { calls.push(`${c.depth}:${c.kind}:${c.id}`); return next(); } });
  await app.run(items.addTwo, { a: "a", b: "b" });
  expect(calls).toEqual(["0:mutation:items.addTwo", "1:mutation:items.add", "1:mutation:items.add", "0:listener:log.onAdded", "0:listener:log.onAdded"]);
});

test("custom jobs adapter: one delivery per listener, enqueued inside the transaction, delivered after", async () => {
  const seen: string[] = [];
  const { app } = setup({
    jobs: { adapter: {
      async enqueue(tx, jobs) { seen.push(`enqueue ${jobs.map((d) => d.kind === "delivery" && `${d.envelope.name}→${d.listener}`)} in tx=${tx !== undefined}`); },
      async deliver(deliveries, { run }) { seen.push("deliver"); for (const d of deliveries) seen.push(await run(d)); },
    }, scope: { load: (saved) => saved } },
  });
  await app.run(items.add, { name: "q" });
  expect(seen).toEqual(["enqueue items.added→log.onAdded in tx=true", "deliver", "done"]);
});

test("deliveries are JSON: what a queue carries comes back and runs", async () => {
  const deliveries: Job[] = [];
  const { app, registry } = setup({ jobs: { adapter: { async deliver(d) { deliveries.push(...d); } }, scope: { load: (saved) => saved } } });
  await app.run(items.add, { name: "j" });
  const d: Delivery = JSON.parse(JSON.stringify(deliveries[0]));
  expect(d).toMatchObject({ listener: "log.onAdded", envelope: { name: "items.added", depth: 1, scope: { locale: "es" }, payload: { name: "j" } } });
  expect(d).toMatchObject({ kind: "delivery", attempts: 1, id: `log.onAdded@${d.envelope.id}` });
  expect(await registry.jobs.run(d)).toEqual("done");
});

test("abort signal: checked before the call starts, never between its steps", async () => {
  const { registry } = setup();
  const app = registry.as({ actor: "a", locale: "es" });
  const aborted = AbortSignal.abort();
  await expect(app.run(items.list, undefined, { signal: aborted })).rejects.toThrow();

  const ctrl = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const twoSteps = action({
    async handler({ run, signal }) {
      seen.push(signal);
      await run(add, { name: "first" });
      ctrl.abort(); // the caller disconnects mid-workflow
      await run(add, { name: "second" }); // inherited signal: not checked, so the workflow finishes
      await expect(run(add, { name: "third" }, { signal: ctrl.signal })).rejects.toThrow(); // passed explicitly: checked
      return "done";
    },
  });
  const r = createRegistry<Scope>({ modules: { items, log, x: { twoSteps } }, database: memoryDatabase(), services: { log: [] } });
  expect(await r.as({ actor: "a", locale: "es" }).run(twoSteps, undefined, { signal: ctrl.signal })).toBe("done");
  expect(seen).toEqual([ctrl.signal]); // actions get it as ctx.signal, to pass on to fetch
});

test("run options: events emitted by the callee carry its scope; the caller's own events don't", async () => {
  const emits = mutation({
    input: z.object({ name: z.string() }),
    async handler({ run }, { name }) {
      return run(add, { name }, { scope: { actor: "system" } });
    },
  });
  const seen: Envelope[] = [];
  const r = createRegistry<Scope>({
    modules: { items, log, x: { emits } },
    database: memoryDatabase(),
    services: { log: [] },
    jobs: { adapter: { deliver: async (jobs) => void seen.push(...jobs.flatMap((d) => (d.kind === "delivery" ? [d.envelope] : []))) }, scope: { load: (saved) => saved } },
  });
  await r.as({ actor: "ana", locale: "es" }).run(emits, { name: "z" });
  expect(seen.map((e) => e.scope)).toEqual([{ actor: "system", locale: "es" }]);
});

test("guards: unregistered functions and missing database", async () => {
  const stray = query({ handler: async () => 1 });
  const { app } = setup();
  await expect(app.run(stray)).rejects.toThrow(/isn't registered/);
  let threw = false;
  try { createRegistry({ modules: { items } }); } catch (e) { threw = /database adapter/.test((e as Error).message); }
  expect(threw).toBe(true);
});

test("ctx errors are namespaced to the module they're thrown from", async () => {
  const fails = query({
    input: z.object({ kind: z.enum(["reject", "conflict", "notFound", "deny"]) }),
    async handler(ctx, { kind }) {
      if (kind === "reject") throw ctx.errors.reject("not_pending", { status: "done" });
      if (kind === "conflict") throw ctx.errors.conflict("slug_taken");
      if (kind === "notFound") throw ctx.errors.notFound();
      throw ctx.errors.deny();
    },
  });
  const app = createRegistry<Scope>({ modules: { bookings: { fails } } }).as({ actor: "a", locale: "es" });
  const err = (kind: "reject" | "conflict" | "notFound" | "deny") => app.run(fails, { kind }).catch((e: DomainError) => [e.kind, e.code, e.details]);
  expect(await err("reject")).toEqual(["rejected", "bookings.not_pending", { status: "done" }]);
  expect(await err("conflict")).toEqual(["conflict", "bookings.slug_taken", undefined]);
  expect(await err("notFound")).toEqual(["not_found", "bookings.not_found", undefined]);
  expect(await err("deny")).toEqual(["forbidden", "bookings.fails.forbidden", undefined]);
  expect(isDomainError(await app.run(fails, { kind: "conflict" }).catch((e) => e), "bookings.slug_taken")).toBe(true);
});

test("another module's error passes through run unchanged, and an action can catch it", async () => {
  const take = mutation({ input: z.object({}), handler: async ({ errors }) => { throw errors.conflict("taken"); } });
  const tryTake = action({
    input: z.object({}),
    async handler({ run }) {
      try { return await run(take, {}); } catch (e) { if (isDomainError(e, "slots.taken")) return "fallback"; throw e; }
    },
  });
  const app = createRegistry<Scope>({ modules: { slots: { take }, booking: { tryTake } }, database: memoryDatabase() }).as({ actor: "a", locale: "es" });
  expect(await app.run(tryTake, {})).toEqual("fallback");
});

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

test("long-lived process: concurrent requests never see each other's scope", async () => {
  const slow = query({
    input: z.object({ ms: z.number() }),
    handler: async ({ scope, run }, { ms }) => {
      await new Promise((r) => setTimeout(r, ms));
      return [scope.actor, await run(locale)];
    },
  });
  const d = createRegistry<Scope>({ modules: { items, log, slow: { slow } }, database: memoryDatabase() });
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      d.as({ actor: `u${i}`, locale: `l${i}` }).run(slow, { ms: (i * 7) % 13 }),
    ),
  );
  results.forEach((r, i) => expect(r).toEqual([`u${i}`, `l${i}`]));
});

// ── regressions from the code review ────────────────────────────────────────
const unhandled: unknown[] = [];
const g = globalThis as any;
if (g.process?.on) g.process.on("unhandledRejection", (e: unknown) => unhandled.push(e));
else g.addEventListener?.("unhandledrejection", (ev: any) => { ev.preventDefault?.(); unhandled.push(ev.reason); });
const tick = () => new Promise((r) => setTimeout(r, 20));

const stamped = event({ payload: z.object({ at: z.string().transform((s) => new Date(s)) }) });
const reg = {
  stamped,
  badEmitThenThrow: mutation({
    input: z.object({}),
    async handler({ emit, errors }) {
      emit(stamped, { at: 42 as unknown as string });
      throw errors.reject("boom");
    },
  }),
  stamp: mutation({
    input: z.object({ at: z.string() }),
    async handler({ emit }, { at }) { emit(stamped, { at }); },
  }),
  throwsUndefined: mutation({
    input: z.object({}),
    async handler({ db }) { (db.rows.t ??= []).push("inner"); throw undefined; },
  }),
  swallowsUndefined: mutation({
    input: z.object({}),
    async handler({ db, run }) {
      (db.rows.t ??= []).push("outer");
      try { await run(reg.throwsUndefined, {}); } catch {}
      return "ok";
    },
  }),
  swallowsBadInput: mutation({
    input: z.object({}),
    async handler({ db, run }) {
      (db.rows.t ??= []).push("outer");
      // @ts-expect-error deliberately invalid
      try { await run(add, { name: 1 }); } catch {}
      return "ok";
    },
  }),
} as const;
const seen: { at: unknown }[] = [];
const regListeners = { onStamped: listener({ event: () => stamped, handler: async (_, payload) => { seen.push(payload); } }) };

function regSetup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const db = memoryDatabase();
  const d = createRegistry<Scope>({ modules: { items, log, reg, regListeners }, database: db, services: { log: [] }, ...extra });
  return { db, app: d.as({ actor: "a", locale: "es" }), d };
}

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
  seen.length = 0;
  await app.run(reg.stamp, { at: "2026-07-01T00:00:00Z" });
  expect(seen[0]!.at instanceof Date).toBe(true);
});

test("a caught nested failure of any kind dooms the transaction: `throw undefined`, invalid input", async () => {
  const { app, db } = regSetup();
  await expect(app.run(reg.swallowsUndefined, {})).rejects.toThrow();
  await expect(app.run(reg.swallowsBadInput, {})).rejects.toThrow(/run with invalid input/);
  expect(db.store.rows.t).toEqual(undefined);
});

test("in-process stores nothing: sweep resolves zeros (one cron works with any adapter), retry throws", async () => {
  const { registry } = setup();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 });
  await expect(registry.jobs.retry("log.onAdded@e1")).rejects.toThrow(/keeps no jobs, so there's nothing to retry \(log\.onAdded@e1\)/);
});

test("registry.jobs.run: a throw retries while the job has tries left; rules and stale payloads fail at once", async () => {
  const happened = event({ payload: z.object({ kind: z.string() }) });
  let runs = 0;
  const react = listener({
    event: () => happened,
    attempts: 3,
    async handler(ctx, { kind }) {
      runs++;
      if (kind === "boom") throw new Error("exploded");
      if (kind === "gone") throw ctx.errors.notFound();
      if (kind === "taken") throw ctx.errors.conflict("taken");
    },
  });
  const once = listener({ event: () => happened, async handler() { throw new Error("once"); } });
  const reported: FailureInfo[] = [];
  const r = createRegistry<Scope>({ modules: { x: { happened, react, once } }, database: memoryDatabase(), onError: (_e, info) => reported.push(info) });
  const job = (payload: object, listener = "x.react", attempts = 3) => ({ kind: "delivery" as const, id: `${listener}@e`, listener, envelope: { id: "e", name: "x.happened", payload, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 }, attempts });

  expect(await r.jobs.run(job({ kind: "fine" }))).toEqual("done");
  await expect(r.jobs.run(job({ kind: "boom" }), { attempt: 2 })).rejects.toThrow("exploded"); // tries left: the queue redelivers
  expect(reported.at(-1)).toMatchObject({ source: "x.react", job: { id: "x.react@e" }, attempt: 2, outcome: "retry" });
  expect(await r.jobs.run(job({ kind: "boom" }), { attempt: 3 })).toEqual("failed"); // the last try
  expect(reported.at(-1)).toMatchObject({ attempt: 3, outcome: "failed" });

  runs = 0;
  expect(await r.jobs.run(job({ kind: "fine" }), { attempt: 4 })).toEqual("failed"); // its last try crashed: not run again
  expect(runs).toBe(0);
  expect(await r.jobs.run(job({ kind: "x" }, "x.once", 1))).toEqual("failed"); // one try
  expect(await r.jobs.run(job({ kind: "boom" }, "x.react", 1))).toEqual("failed"); // the tries it was queued with, not today's code

  expect(await r.jobs.run(job({ kind: "gone" }))).toEqual("failed"); // a rule said no
  await expect(r.jobs.run(job({ kind: "taken" }))).rejects.toMatchObject({ kind: "conflict" }); // a lost race retries
  expect(await r.jobs.run(job({ nope: 1 }))).toEqual("failed"); // the payload no longer matches its schema
  await expect(r.jobs.run(job({ kind: "fine" }, "x.gone"))).rejects.toThrow(/x\.gone isn't a registered listener/); // code not here: a try like any other
  expect(reported.at(-1)).toMatchObject({ source: "x.gone", attempt: 1, outcome: "retry" });
  expect(await r.jobs.run(job({ kind: "fine" }, "x.gone"), { attempt: 3 })).toEqual("failed"); // the last try: kept for jobs.retry
  expect(reported.at(-1)).toMatchObject({ source: "x.gone", outcome: "failed" });
});

test("listener: attempts is a whole number of tries, delay is seconds", () => {
  const happened = event({ payload: z.object({}) });
  expect(() => listener({ event: () => happened, attempts: 0, async handler() {} })).toThrow(/attempts must be a whole number of tries, 1 or more \(got 0\)/);
  expect(() => listener({ event: () => happened, attempts: 2.5, async handler() {} })).toThrow(/attempts/);
  expect(() => listener({ event: () => happened, delay: -1, async handler() {} })).toThrow(/delay must be seconds, 0 or more \(got -1\)/);
});

test("delay: the job says when it may run; an adapter that can't hold it (in-process) is refused at startup", async () => {
  const happened = event({ payload: z.object({}) });
  const doIt = mutation({ async handler(ctx) { ctx.emit(happened, {}); } });
  const ran: string[] = [];
  const later = listener({ event: () => happened, delay: 90, async handler() { ran.push("later"); } });
  const now = listener({ event: () => happened, async handler() { ran.push("now"); } });
  const jobs: Delivery[] = [];
  const make = (adapter?: JobsAdapter) =>
    createRegistry<Scope>({ modules: { x: { happened, doIt, later, now } }, database: memoryDatabase(), now: () => new Date("2026-07-01T10:00:00Z"), jobs: { adapter, scope: { load: (saved) => saved } } });
  await make({ holds: true, async deliver(d) { jobs.push(...deliveriesIn(d)); } }).as({ actor: "a", locale: "es" }).run(doIt);
  expect(jobs.map((j) => [j.listener, j.runAt])).toEqual([["x.later", "2026-07-01T10:01:30.000Z"], ["x.now", undefined]]);
  // Laravel's sync queue drops the delay; running a "tomorrow" job now would be wrong, so we refuse
  expect(() => make()).toThrow(/x\.later waits 90s, but your jobs adapter can't hold jobs \(inProcess\(\) can't\)\. Use databaseQueue\(database\)/);
  expect(() => make({ holds: { max: 60 }, async deliver() {} })).toThrow(/holds jobs for at most 60s\. Put an outbox in front/);
  expect(ran).toEqual([]);
});

test("adapter hooks: check sees the listeners and database at createRegistry; fail keeps what a consumer failed", async () => {
  const seen: string[] = [];
  const failed: string[] = [];
  const adapter: JobsAdapter = {
    check: ({ listeners, database }) => void seen.push(...listeners.map((l) => l.id), database ? "db" : "no db"),
    deliver: async () => {},
    fail: async (job, error) => void failed.push(`${job.id}: ${(error as Error).message}`),
  };
  const { registry } = setup({ jobs: { adapter, scope: { load: (saved) => saved } }, onError: () => {} });
  expect(seen).toEqual(["log.onAdded", "db"]);
  const job = { kind: "delivery" as const, attempts: 1, id: "log.onAdded@e", listener: "log.onAdded", envelope: { id: "e", name: "items.added", payload: { name: "listener-fails" }, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 } };
  expect(await registry.jobs.run(job)).toEqual("failed");
  expect(failed).toEqual(["log.onAdded@e: listener exploded"]);
});

test("emit takes plain JSON only, so what works in-process works through a queue", async () => {
  const at = event({ payload: z.object({ at: z.any() }) });
  const emitDate = mutation({ handler: async (ctx) => ctx.emit(at, { at: new Date() }) });
  const emitString = mutation({ handler: async (ctx) => ctx.emit(at, { at: "2026-07-01T00:00:00Z" }) });
  const r = createRegistry<Scope>({ modules: { x: { at, emitDate, emitString } }, database: memoryDatabase() });
  await expect(r.as({ actor: "a", locale: "es" }).run(emitDate)).rejects.toThrow(/x\.at payload isn't plain data at at: a Date/);
  await expect(r.as({ actor: "a", locale: "es", when: new Date() } as Scope).run(emitString)).rejects.toThrow(/scope emitting x\.at isn't plain data at when: a Date/);
  await r.as({ actor: "a", locale: "es" }).run(emitString);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  const emitLoop = mutation({ handler: async (ctx) => ctx.emit(at, { at: loop }) });
  const shared = { a: 1 };
  const emitShared = mutation({ handler: async (ctx) => ctx.emit(at, { at: [shared, shared] }) }); // shared isn't circular
  const r2 = createRegistry<Scope>({ modules: { x: { at, emitLoop, emitShared } }, database: memoryDatabase() });
  await expect(r2.as({ actor: "a", locale: "es" }).run(emitLoop)).rejects.toThrow(/at at\.self: a circular reference/);
  await r2.as({ actor: "a", locale: "es" }).run(emitShared);
});

test("listeners see the event without a scope: ctx.scope is the one they run as", async () => {
  const happened = event({ payload: z.object({}) });
  const doIt = mutation({ handler: async (ctx) => ctx.emit(happened, {}) });
  let seen: object | undefined;
  const look = listener({ event: () => happened, async handler(ctx) { seen = ctx.event; } });
  await createRegistry<Scope>({ modules: { x: { happened, doIt, look } }, database: memoryDatabase() }).as({ actor: "a", locale: "es" }).run(doIt);
  expect(seen).toMatchObject({ id: expect.any(String), name: "x.happened", payload: {}, attempt: 1 });
  expect(seen).not.toHaveProperty("scope");
});

test("wrap sees calls that fail validation or authorization (audit trails include denials)", async () => {
  const calls: string[] = [];
  const { d } = regSetup({ wrap: async (c, next) => { try { return await next(); } catch (e) { calls.push(`${c.id}:${(e as DomainError).kind}`); throw e; } } });
  await expect(d.as({ actor: null, locale: "es" }).run(add, { name: "x" })).rejects.toThrow();
  // @ts-expect-error invalid on purpose
  await expect(d.as({ actor: "a", locale: "es" }).run(add, { name: 1 })).rejects.toThrow();
  expect(calls).toEqual(["items.add:forbidden", "items.add:invalid"]);
});

test("authorize runs before validation: anonymous callers never see a protected function's schema errors", async () => {
  const { d } = regSetup();
  // @ts-expect-error invalid on purpose
  await expect(d.as({ actor: null, locale: "es" }).run(add, { name: 1 })).rejects.toMatchObject({ kind: "forbidden" });
});

test("adapters without interactive transactions are refused", () => {
  let msg = "";
  try { createRegistry({ modules: { items }, database: { ...memoryDatabase(), transactions: "none" } as any }); } catch (e) { msg = (e as Error).message; }
  expect(/interactive transactions/.test(msg)).toBe(true);
});

test("invalid or denied calls never open a transaction", async () => {
  const db = memoryDatabase();
  let opened = 0;
  const counting = { ...db, transaction: <T>(fn: (tx: Store) => Promise<T>) => { opened++; return db.transaction(fn); } };
  const r = createRegistry<Scope>({ modules: { items, log }, database: counting, services: { log: [] } });
  await expect(r.as({ actor: null, locale: "es" }).run(add, { name: "x" })).rejects.toMatchObject({ kind: "forbidden" });
  // @ts-expect-error invalid on purpose
  await expect(r.as({ actor: "a", locale: "es" }).run(add, { name: 1 })).rejects.toMatchObject({ kind: "invalid" });
  expect(opened).toEqual(0);
});

test("an adapter that retries the transaction delivers each event once", async () => {
  const db = memoryDatabase();
  let attempts = 0;
  // first attempt runs fully, then "fails to commit" (a serialization failure); the adapter retries
  const retrying = { ...db, transaction: async <T>(fn: (tx: Store) => Promise<T>) => {
    await db.transaction(async (tx) => { attempts++; await fn(tx); throw new Error("40001"); }).catch(() => {});
    attempts++;
    return db.transaction(fn);
  } };
  const services = { log: [] as string[] };
  const r = createRegistry<Scope>({ modules: { items, log }, database: retrying, services });
  await r.as({ actor: "a", locale: "es" }).run(add, { name: "once" });
  expect(attempts).toEqual(2);
  expect(services.log).toEqual(["added once (items.added, es)"]);
});

test("a mutation that loses a race (deadlock) is re-run in a fresh transaction; events go out once", async () => {
  const db = memoryDatabase();
  let attempts = 0;
  const racy = { ...db, retryable: (e: unknown) => (e as { code?: string }).code === "40P01",
    transaction: <T>(fn: (tx: Store) => Promise<T>) => db.transaction(async (tx) => {
      const out = await fn(tx);
      if (++attempts === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return out;
    }) };
  const services = { log: [] as string[] };
  const r = createRegistry<Scope>({ modules: { items, log }, database: racy, services });
  expect(await r.as({ actor: "a", locale: "es" }).run(add, { name: "again" })).toEqual({ name: "again" });
  expect(attempts).toEqual(2);
  expect(db.store.rows.items).toEqual([{ name: "again" }]);
  expect(services.log).toEqual(["added again (items.added, es)"]);
});

test("retries stop after `transactionAttempts`, and errors that aren't retryable are never retried", async () => {
  let calls = 0;
  const db = memoryDatabase();
  const alwaysDeadlocks = { ...db, retryable: () => true,
    transaction: async () => { calls++; throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); } };
  const r = createRegistry<Scope>({ modules: { items, log }, database: { ...alwaysDeadlocks, transactionAttempts: 2 }, services: { log: [] } });
  await expect(r.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(2);

  calls = 0;
  const r2 = createRegistry<Scope>({ modules: { items, log }, database: { ...alwaysDeadlocks, retryable: () => false }, services: { log: [] } });
  await expect(r2.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(1);

  expect(() => createRegistry<Scope>({ modules: {}, database: { ...db, transactionAttempts: 0 } })).toThrow(
    /database transaction attempts must be a whole number of tries, 1 or more \(got 0\)/,
  );
});

test("a test registry keeps the app's transactionAttempts, whatever its adapter's nest returns", async () => {
  let calls = 0;
  const db = memoryDatabase();
  const tx = { ...db, retryable: () => true, transaction: async () => { calls++; throw new Error("deadlock detected"); } };
  const database = { ...db, transactionAttempts: 5, nest: () => tx };
  const t = createTestRegistry(createRegistry<Scope>({ modules: { items, log }, database, services: { log: [] } }));
  await t.begin();
  await expect(t.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(5);
  await t.rollback();
});

test("listener loops stop at maxEventDepth (default 8 hops) and are reported once, not thrown", async () => {
  const ping = event({ payload: z.object({ n: z.number() }) });
  const bump = mutation({ input: z.object({ n: z.number() }), handler: async ({ emit }, { n }) => emit(ping, { n }) });
  const hops: number[] = [];
  const loop = listener({ event: () => ping, handler: async ({ run }, { n }) => { hops.push(n); await run(bump, { n: n + 1 }); } });
  for (const [maxEventDepth, expected] of [[undefined, 8], [5, 5]] as const) {
    hops.length = 0;
    const errors: string[] = [];
    const d = createRegistry<Scope>({ modules: { l: { ping, bump, loop } }, database: memoryDatabase(), jobs: { maxEventDepth }, onError: (e, { source }) => errors.push(`${source}: ${(e as Error).message}`) });
    await d.as({ actor: "a", locale: "es" }).run(bump, { n: 0 });
    expect(hops.length).toEqual(expected);
    expect(errors).toEqual([expect.stringMatching(new RegExp(`^l\\.ping: .*deeper than ${expected}`))]);
  }
});

test("meta is set per function and visible in wrap and the registry", async () => {
  const m = init<{ scope: Scope; meta: { tags: string[] } }>();
  const tagged = m.query({ meta: { tags: ["billing"] }, handler: async () => 1 });
  const seen: unknown[] = [];
  const r = m.createRegistry({ modules: { billing: { tagged } }, wrap: async (call, next) => { seen.push(call.meta?.tags); return next(); } });
  await r.as({ actor: "a", locale: "es" }).run(tagged);
  expect(seen).toEqual([["billing"]]);
  expect(r.definitions.functions.find((f) => f.id === "billing.tagged")?.fn.meta).toEqual({ tags: ["billing"] });
});

test("listeners carry meta into wrap, like functions", async () => {
  const m = init<{ scope: Scope; db: Store; meta: { tags: string[] } }>();
  const happened = m.event({ payload: z.object({}) });
  const doIt = m.mutation({ async handler(ctx) { ctx.emit(happened, {}); } });
  const audit = m.listener({ event: () => happened, meta: { tags: ["audit"] }, async handler() {} });
  const seen: string[] = [];
  const r = m.createRegistry({
    modules: { x: { happened, doIt, audit } },
    database: memoryDatabase(),
    wrap: async (call, next) => { seen.push(`${call.kind}:${call.meta?.tags ?? "-"}`); return next(); },
  });
  await r.as({ actor: "a", locale: "es" }).run(doIt);
  expect(seen).toEqual(["mutation:-", "listener:audit"]);
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
  await createRegistry<Scope>({ modules: { x: { happened, doIt, listen } }, database: memoryDatabase() }).as({ actor: "a", locale: "es" }).run(doIt, {});
  expect(got).toEqual(["before"]);
});

test("ids: an explicit id is local to its module, and jobs store it", async () => {
  const happened = event({ id: "happened", payload: z.object({}) });
  const doIt = mutation({ id: "do", async handler(ctx) { ctx.emit(happened, {}); } });
  const ran: string[] = [];
  const send = listener({ id: "send", event: () => happened, handler: async () => void ran.push("send") });
  const jobs: Delivery[] = [];
  const r = createRegistry<Scope>({
    modules: { notifications: { renamedEvent: happened, renamedFn: doIt, renamedListener: send } },
    database: memoryDatabase(),
    jobs: { adapter: { async deliver(d, { run }) { jobs.push(...deliveriesIn(d)); for (const j of d) await run(j); } }, scope: { load: (saved) => saved } },
  });
  expect(r.idOf(doIt)).toBe("notifications.do");
  expect(r.definitions.listeners.map((l) => [l.id, l.name])).toEqual([["notifications.send", "renamedListener"]]);
  await r.as({ actor: "a", locale: "es" }).run(doIt);
  expect(jobs.map((j) => [j.listener, j.envelope.name])).toEqual([["notifications.send", "notifications.happened"]]);
  expect(ran).toEqual(["send"]);
});

test("ids: a duplicate or a dotted id throws at createRegistry", () => {
  const a = query({ handler: async () => 1 });
  const b = query({ id: "a", handler: async () => 2 });
  expect(() => createRegistry({ modules: { m: { a, b } } })).toThrow("m.a and m.b both have the id m.a. Ids must be unique");
  const dotted = query({ id: "other.a", handler: async () => 1 });
  expect(() => createRegistry({ modules: { m: { dotted } } })).toThrow(/m\.dotted has id "other\.a"\. Give the local name/);
});

test("jobs.scope: store picks what's saved, load rebuilds it at run time, null discards", async () => {
  const m = init<{ scope: Scope; db: Store }>();
  const happened = m.event({ payload: z.object({ n: z.number() }) });
  const doIt = m.mutation({ input: z.object({ n: z.number() }), async handler(ctx, { n }) { ctx.emit(happened, { n }); } });
  const seen: Scope[] = [];
  const react = m.listener({ event: () => happened, async handler({ scope }) { seen.push(scope); } });
  const stored: object[] = [];
  const outcomes: string[] = [];
  const reported: string[] = [];
  const r = m.createRegistry({
    modules: { x: { happened, doIt, react } },
    database: memoryDatabase(),
    onError: (e) => reported.push((e as Error).message),
    jobs: {
      adapter: { async deliver(d, { run }) { for (const j of deliveriesIn(d)) { stored.push(j.envelope.scope); outcomes.push(await run(j)); } } },
      scope: {
        store: (s) => ({ actor: s.actor }), // the locale isn't saved
        load: async (saved) => (saved.actor === "gone" ? null : { actor: saved.actor, locale: "fresh" }),
      },
    },
  });
  await r.as({ actor: "ana", locale: "es" }).run(doIt, { n: 1 });
  await r.as({ actor: "gone", locale: "es" }).run(doIt, { n: 2 });
  expect(stored).toEqual([{ actor: "ana" }, { actor: "gone" }]);
  expect(seen).toEqual([{ actor: "ana", locale: "fresh" }]);
  expect(outcomes).toEqual(["done", "discarded"]);
  expect(reported).toEqual([expect.stringMatching(/jobs\.scope\.load returned null for x\.react@.+, so it was discarded/)]);
});

test("jobs.scope: what store returns must be plain JSON; a load that throws is retried", async () => {
  const happened = event({ payload: z.object({}) });
  const doIt = mutation({ async handler(ctx) { ctx.emit(happened, {}); } });
  const react = listener({ event: () => happened, attempts: 2, async handler() {} });
  const make = (scope: object) => createRegistry<Scope>({ modules: { x: { happened, doIt, react } }, database: memoryDatabase(), onError: () => {}, jobs: { scope } });
  await expect(make({ store: () => ({ at: new Date() }), load: () => null }).as({ actor: "a", locale: "es" }).run(doIt)).rejects.toThrow(/scope emitting x\.happened isn't plain data at at: a Date/);
  const flaky = make({ load: async () => { throw new Error("db down"); } });
  const job = { kind: "delivery" as const, attempts: 2, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  await expect(flaky.jobs.run(job)).rejects.toThrow("db down");
});

test("a job of a kind this version doesn't know uses its attempts, then the adapter keeps it", async () => {
  const kept: string[] = [];
  const { registry } = setup({ onError: () => {}, jobs: { adapter: { deliver: async () => {}, fail: async (_job, e) => void kept.push((e as Error).message) }, scope: { load: (saved) => saved } } });
  const job = { kind: "nope", id: "x", attempts: 2, listener: "log.onAdded", envelope: { id: "e", name: "items.added", payload: { name: "a" }, scope: {}, occurredAt: "", depth: 1 } };
  await expect(registry.jobs.run(job as never)).rejects.toThrow(/which this version can't run/);
  expect(await registry.jobs.run(job as never, { attempt: 2 })).toEqual("failed");
  expect(kept).toEqual([expect.stringMatching(/job x has kind "nope", which this version can't run/)]);
});

test("jobs.scope.load failing counts as a try: at the default of one, the job fails", async () => {
  const happened = event({ payload: z.object({}) });
  const react = listener({ event: () => happened, async handler() {} });
  const r = createRegistry<Scope>({ modules: { x: { happened, react } }, onError: () => {}, jobs: { scope: { load: async () => { throw new Error("db down"); } } } });
  const job = { kind: "delivery" as const, attempts: 1, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  expect(await r.jobs.run(job)).toEqual("failed");
});

test("jobs.scope: any adapter but inProcess() keeps jobs to run later, so it needs load: a job runs with today's roles", () => {
  const later = { holds: true as const, async deliver() {} };
  const forwards = { async deliver() {} }; // sends to a queue: it keeps them too
  // @ts-expect-error the types ask for scope; createRegistry still checks, for JS and a scope without load
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: later } })).toThrow(/keeps jobs to run later, so set jobs\.scope\.load/);
  // @ts-expect-error the same, for an adapter that only forwards
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: forwards } })).toThrow(/jobs\.scope\.load/);
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: later, scope: { load: (saved) => saved } } })).not.toThrow(); // keeping it as it was is a choice you write down
  expect(() => createRegistry<Scope>({ modules: {}, jobs: { adapter: inProcess() } })).not.toThrow(); // runs now, in this process: nothing waits
});

test("jobs.scope: store without load throws; load returning undefined retries instead of discarding", async () => {
  expect(() => createRegistry({ modules: {}, jobs: { scope: { store: (s: object) => s } as never } })).toThrow("jobs.scope has store but no load");
  const happened = event({ payload: z.object({}) });
  const react = listener({ event: () => happened, attempts: 2, async handler() {} });
  const r = createRegistry<Scope>({ modules: { x: { happened, react } }, onError: () => {}, jobs: { scope: { load: (() => undefined) as never } } });
  const job = { kind: "delivery" as const, attempts: 2, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  await expect(r.jobs.run(job)).rejects.toThrow(/load returned undefined for x\.react@e\. Return the scope, or null to discard/);
});

// ── crons ────────────────────────────────────────────────────────────────────
const system: Scope = { actor: "system", locale: "en" };

function cronSetup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const ran: string[] = [];
  const report = action({
    input: z.object({ kind: z.string() }),
    authorize: signedIn,
    async handler(ctx, { kind }) {
      if (kind === "broken") throw new Error("smtp down");
      ran.push(`${kind} as ${ctx.scope.actor}`);
    },
  });
  const weekly = cron({ schedule: "0 9 * * 1", run: report, input: { kind: "weekly" }, scope: system });
  const friday = cron({ schedule: "0 18 * * 5", timezone: "Europe/Madrid", run: report, input: { kind: "friday" }, scope: system });
  const broken = cron({ schedule: "0 9 * * 1", run: report, input: { kind: "broken" }, scope: system, attempts: 2 });
  const registry = createRegistry<Scope>({ modules: { reports: { report, weekly, friday, broken } }, database: memoryDatabase(), ...extra });
  return { registry, ran };
}

test("crons: tick runs what's due that minute, as the cron's scope, with its input", async () => {
  const { registry, ran } = cronSetup({ onError: () => {} });
  expect(registry.definitions.crons.map((c) => c.id)).toEqual(["reports.weekly", "reports.friday", "reports.broken"]);
  expect(await registry.jobs.tick(new Date("2026-11-23T09:00:42Z"))).toEqual(["reports.weekly", "reports.broken"]); // a Monday, any second of 9:00
  expect(ran).toEqual(["weekly as system"]);
  expect(await registry.jobs.tick(new Date("2026-11-23T09:01:00Z"))).toEqual([]);
  expect(await registry.jobs.tick(new Date("2026-11-27T17:00:00Z"))).toEqual(["reports.friday"]); // 18:00 in Madrid
  await expect(registry.jobs.tick(new Date("garbage"))).rejects.toThrow(/tick needs a valid date/);
  expect(ran).toEqual(["weekly as system", "friday as system"]);
});

test("crons: a run is a job, `<cron id>@<minute>`, through the jobs adapter, with the cron's attempts", async () => {
  const sent: Job[] = [];
  const reported: FailureInfo[] = [];
  const { registry, ran } = cronSetup({ jobs: { adapter: { async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (saved) => saved } }, onError: (_e, info) => reported.push(info) });
  await registry.jobs.tick(new Date("2026-11-23T09:00:00Z"));
  expect(sent).toEqual([
    { kind: "cron", id: "reports.weekly@20261123T0900Z", cron: "reports.weekly", scheduledAt: "2026-11-23T09:00:00.000Z", attempts: 1 },
    { kind: "cron", id: "reports.broken@20261123T0900Z", cron: "reports.broken", scheduledAt: "2026-11-23T09:00:00.000Z", attempts: 2 },
  ]);
  expect(ran).toEqual([]); // the adapter runs them, not tick
  const [, broken] = sent;
  await expect(registry.jobs.run(broken!, { attempt: 1 })).rejects.toThrow("smtp down"); // a try left
  expect(await registry.jobs.run(broken!, { attempt: 2 })).toBe("failed");
  expect(reported.at(-1)).toMatchObject({ source: "reports.broken", job: { id: "reports.broken@20261123T0900Z" }, outcome: "failed" });
  expect(await registry.jobs.run({ kind: "cron", id: "reports.gone@x", cron: "reports.gone", scheduledAt: "", attempts: 1 })).toBe("failed"); // renamed or removed
});

test("crons: a schedule, time zone, function or input it can't use fails at startup", () => {
  const ping = query({ handler: async () => 1 });
  expect(() => cron({ schedule: "@daily", run: ping, scope: system })).toThrow(/needs five fields/);
  expect(() => cron({ schedule: "0 9 * * *", timezone: "Europe/Madird", run: ping, scope: system })).toThrow(RangeError);
  expect(() => cron({ schedule: "0 9 * * *", run: ping, scope: system, attempts: 0 })).toThrow(/cron attempts must be a whole number/);
  const orphan = cron({ schedule: "0 9 * * *", run: ping, scope: system });
  expect(() => createRegistry<Scope>({ modules: { x: { orphan } } })).toThrow(/Cron x\.orphan runs a function that isn't registered/);
  const dated = query({ input: z.object({ at: z.any() }), handler: async () => 1 });
  const withDate = cron({ schedule: "0 9 * * *", run: dated, input: { at: new Date() }, scope: system });
  expect(() => createRegistry<Scope>({ modules: { x: { dated, withDate } } })).toThrow(/x\.withDate input isn't plain data at at: a Date/);
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

// ── ctx.schedule ─────────────────────────────────────────────────────────────
function scheduleSetup(extra: Partial<Parameters<typeof createRegistry>[0]> = {}) {
  const reminded: string[] = [];
  const remind = action({
    input: z.object({ who: z.string() }),
    async handler(ctx, { who }) {
      if (who === "nobody") throw ctx.errors.notFound();
      reminded.push(`${who} as ${ctx.scope.actor} in ${ctx.scope.locale}`);
    },
  });
  const book = mutation({
    input: z.object({ who: z.string(), fail: z.boolean().optional(), at: z.string().optional() }),
    async handler(ctx, { who, fail, at }) {
      const id = ctx.schedule(remind, { who }, at ? { at: new Date(at) } : { delay: 3600 });
      if (fail) throw ctx.errors.reject("nope");
      return id;
    },
  });
  const sent: Job[] = [];
  const registry = createRegistry<Scope>({
    modules: { bookings: { remind, book } },
    database: memoryDatabase(),
    now: () => new Date("2026-07-01T10:00:00Z"),
    jobs: { adapter: { holds: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (saved) => saved } },
    ...extra,
  });
  return { registry, book, reminded, sent, app: registry.as({ actor: "ana", locale: "es" }) };
}

test("ctx.schedule: a job committed with the mutation, as the caller's scope, for the adapter to hold", async () => {
  const { app, book, sent } = scheduleSetup();
  const id = await app.run(book, { who: "guest" });
  expect(sent).toEqual([
    { kind: "call", attempts: 1, depth: 0, id, fn: "bookings.remind", input: { who: "guest" }, scope: { actor: "ana", locale: "es" }, runAt: "2026-07-01T11:00:00.000Z" },
  ]);
  await expect(app.run(book, { who: "x", fail: true })).rejects.toMatchObject({ kind: "rejected" });
  expect(sent).toHaveLength(1); // rolled back: nothing scheduled
  await app.run(book, { who: "y", at: "2026-07-02T09:00:00Z" });
  expect(sent[1]).toMatchObject({ runAt: "2026-07-02T09:00:00.000Z" });
});

test("ctx.schedule: refused where nothing can hold it (in-process), or for longer than the adapter can", async () => {
  const { app, book } = scheduleSetup({ jobs: {} });
  await expect(app.run(book, { who: "guest" })).rejects.toThrow(/ctx\.schedule\(bookings\.remind\) waits 3600s, but your jobs adapter can't hold jobs/);
  const short = scheduleSetup({ jobs: { adapter: { holds: { max: 60 }, async deliver() {} }, scope: { load: (saved) => saved } } });
  await expect(short.app.run(short.book, { who: "guest" })).rejects.toThrow(/holds jobs for at most 60s/);
  await expect(short.app.run(short.book, { who: "guest", at: "not a date" })).rejects.toThrow(/needs an `at` date or a `delay`/);
});

test("ctx.schedule: the job runs its function as the stored scope, loaded fresh; a rule saying no fails it", async () => {
  const { app, book, reminded, registry } = scheduleSetup({
    onError: () => {},
    jobs: {
      adapter: { holds: true, async deliver() {} },
      scope: { load: (saved: { actor: string | null }) => ({ actor: saved.actor, locale: "en" }) }, // today's settings
    },
  });
  const run = (job: Job) => registry.jobs.run(job);
  const id = await app.run(book, { who: "guest" });
  const job = { kind: "call" as const, attempts: 1, depth: 0, id, fn: "bookings.remind", input: { who: "guest" }, scope: { actor: "ana" } };
  expect(await run(job)).toBe("done");
  expect(reminded).toEqual(["guest as ana in en"]); // load rebuilt the locale
  expect(await run({ ...job, input: { who: "nobody" } })).toBe("failed"); // not_found: no retry
  expect(await run({ ...job, fn: "bookings.gone" })).toBe("failed"); // renamed or removed: kept for retry
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

test("ctx.schedule: due now runs after commit like a listener; a negative delay or a bad input is a bug", async () => {
  const ran: string[] = [];
  const ping = action({ input: z.object({ n: z.number() }), async handler(_ctx, { n }) { ran.push(`ping ${n}`); } });
  const go = mutation({
    input: z.object({ delay: z.number(), n: z.any() }),
    async handler(ctx, { delay, n }) { ctx.schedule(ping, { n }, { delay }); },
  });
  const app = createRegistry<Scope>({ modules: { x: { ping, go } }, database: memoryDatabase() }).as({ actor: "a", locale: "es" });
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
    database: memoryDatabase(),
    onError: () => {},
    jobs: { adapter: { holds: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (saved) => saved } },
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
  const r = createRegistry<Scope>({ modules: { x: { again } }, database: memoryDatabase(), jobs: { maxEventDepth: 4 }, onError: (e) => errors.push((e as Error).message) });
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
  const r = createRegistry<Scope>({ modules: { x: { pinged, ping, pong, serve } }, database: memoryDatabase(), jobs: { maxEventDepth: 6 }, onError: (e) => errors.push((e as Error).message) });
  await r.as({ actor: "a", locale: "es" }).run(ping);
  expect(runs).toBe(3); // event (1), call (2), event (3), call (4), event (5), call (6), event (7): stopped
  expect(errors).toEqual([expect.stringMatching(/deeper than 6/)]);

  // a commit past the limit drops what's too deep, not a call that waits: that one starts a new chain
  const held: Job[] = [];
  const deep = mutation({ async handler(ctx) { ctx.emit(pinged, {}); ctx.schedule(ping, undefined, { delay: 60 }); } });
  const r2 = createRegistry<Scope>({
    modules: { x: { pinged, ping, deep } },
    database: memoryDatabase(),
    onError: () => {},
    jobs: { adapter: { holds: true, async deliver(jobs) { held.push(...jobs); } }, scope: { load: (saved) => saved }, maxEventDepth: 0 },
  });
  await r2.as({ actor: "a", locale: "es" }).run(deep);
  expect(held).toMatchObject([{ kind: "call", depth: 0 }]);

  const sent: Job[] = [];
  const later = mutation({ async handler(ctx) { ctx.schedule(ping, undefined, { delay: 60 }); } });
  const waits = createRegistry<Scope>({
    modules: { x: { pinged, ping, later } },
    database: memoryDatabase(),
    jobs: { adapter: { holds: true, async deliver(jobs) { sent.push(...jobs); } }, scope: { load: (saved) => saved } },
  });
  await waits.as({ actor: "a", locale: "es" }).run(later);
  expect(sent).toMatchObject([{ kind: "call", depth: 0 }]); // waiting a minute is a new chain, not a loop
});

test("a cron starts a chain: what its function emits is the first hop", async () => {
  const pinged = event({ payload: z.object({}) });
  const ping = mutation({ async handler(ctx) { ctx.emit(pinged, {}); } });
  const pong = listener({ event: () => pinged, async handler() {} });
  const nightly = cron({ schedule: "0 3 * * *", run: ping, scope: { actor: null, locale: "en" } });
  const depths: number[] = [];
  const r = createRegistry<Scope>({
    modules: { x: { pinged, ping, pong, nightly } },
    database: memoryDatabase(),
    jobs: {
      adapter: {
        async deliver(jobs, runner) {
          for (const job of jobs) {
            if (job.kind === "delivery") depths.push(job.envelope.depth);
            else await runner.run(job);
          }
        },
      },
      scope: { load: (saved) => saved },
    },
  });
  await r.jobs.tick(new Date("2026-11-23T03:00:00Z"));
  expect(depths).toEqual([1]);
});

test("ctx.schedule replace: in tests too, the newer call replaces the one waiting, so only it runs", async () => {
  const sent: string[] = [];
  const remind = action({ input: z.object({ at: z.string() }), async handler(_ctx, { at }) { sent.push(at); } });
  const book = mutation({
    input: z.object({ checkIn: z.string(), twice: z.boolean().optional() }),
    async handler(ctx, { checkIn, twice }) {
      if (twice) ctx.schedule(remind, { at: "draft" }, { delay: 60, replace: "b1" }); // the later one in this transaction wins
      ctx.schedule(remind, { at: checkIn }, { delay: 3600, replace: "b1" });
    },
  });
  const replacing = { holds: true as const, replaces: true as const, async deliver() {} };
  const registry = createRegistry<Scope>({ modules: { x: { remind, book } }, database: memoryDatabase(), jobs: { adapter: replacing, scope: { load: (saved) => saved } } });
  const t = createTestRegistry(registry, { now: "2026-07-01T10:00:00Z" });
  await t.begin();
  const app = t.as({ actor: "ana", locale: "es" });
  await app.run(book, { checkIn: "July 3", twice: true });
  await app.run(book, { checkIn: "July 9" }); // the dates changed
  expect(t.jobs.scheduled.map((j) => j.input)).toEqual([{ at: "July 9" }]);
  await t.jobs.drain({ until: "2026-07-02T00:00:00Z" });
  expect(sent).toEqual(["July 9"]);
  await t.rollback();
});

test("ctx.schedule replace: refused where nothing can replace (in-process), and the key can't be empty", async () => {
  const ping = action({ async handler() {} });
  const go = mutation({ input: z.object({ key: z.string() }), async handler(ctx, { key }) { ctx.schedule(ping, undefined, { delay: 0, replace: key }); } });
  const app = createRegistry<Scope>({ modules: { x: { ping, go } }, database: memoryDatabase() }).as({ actor: "a", locale: "es" });
  await expect(app.run(go, { key: "b1" })).rejects.toThrow(/your jobs adapter can't replace one it already has\. Use databaseQueue\(database\)/);
  await expect(app.run(go, { key: "" })).rejects.toThrow(/replace must be a non-empty key/);
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
  const registry = createRegistry<Scope>({ modules: { x: { pulse, rearm } }, database: memoryDatabase(), jobs: { adapter: { holds: true, async deliver() {} }, scope: { load: (saved) => saved } } });
  const t = createTestRegistry(registry, { now: "2026-07-01T10:00:00Z" });
  await t.begin();
  await t.as({ actor: "a", locale: "es" }).run(rearm);
  await t.jobs.drain({ until: "2026-07-01T13:30:00Z" });
  expect(seen).toEqual(["11:00", "12:00", "13:00"]);
  expect(t.jobs.scheduled.map((j) => j.runAt)).toEqual(["2026-07-01T14:00:00.000Z"]);
  await expect(t.jobs.drain({ until: "garbage" })).rejects.toThrow(/needs a valid date/);
  await t.rollback();
});

test("inProcess() and inline tests try once: a job with attempts left is failed, never a retry that won't come", async () => {
  const { mutation, event, listener, createRegistry } = init<{ scope: object; db: Store }>();
  const happened = event({ payload: z.object({}) });
  const go = mutation({ async handler(ctx) { ctx.emit(happened, {}); } });
  let tries = 0;
  const flaky = listener({ event: () => happened, attempts: 3, async handler() { tries++; throw new Error("down"); } });
  const outcomes: (string | undefined)[] = [];
  const registry = createRegistry({
    modules: { x: { happened, go, flaky } },
    database: memoryDatabase(),
    onError: (_error, info) => void outcomes.push(info.outcome),
  });
  await registry.as({}).run(go);

  const t = createTestRegistry(registry);
  await t.begin();
  await expect(t.as({}).run(go)).rejects.toThrow("down");
  await t.rollback();

  expect(tries).toBe(2);
  expect(outcomes).toEqual(["failed", "failed"]);
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
  const queued = createRegistry<Scope>({ modules, database: memoryDatabase(), services: { log: [] }, jobs: { adapter, scope: { load: (s) => s } } });
  await queued.as(scope).run(place, { total: 100 });
  await queued.as(scope).run(place, { total: 9000 });
  expect(deliveriesIn(enqueued).map((d) => `${d.listener} ${(d.envelope.payload as { total: number }).total}`)).toEqual(["o.always 100", "o.fraud 9000", "o.always 9000"]);
  expect(seen).toEqual([{ total: 100, currency: "EUR" }, { total: 9000, currency: "EUR" }]); // parsed: the default is there

  // inProcess: it doesn't run; a throw fails the mutation and rolls it back
  const database = memoryDatabase();
  const app = createRegistry<Scope>({ modules, database, services: { log: [] } }).as(scope);
  await app.run(place, { total: 100 });
  await app.run(place, { total: 9000 });
  expect(ran).toEqual([9000]);
  await expect(app.run(place, { total: -1 })).rejects.toThrow("[logic-sdk] o.fraud's when threw on o.placed: a bug in when");
  expect(database.store.rows.orders).toEqual([{ total: 100 }, { total: 9000 }]);

  // the test registry: no queued job for it; perform, which names the listener, skips `when`
  const t = createTestRegistry(createRegistry<Scope>({ modules, database: memoryDatabase(), services: { log: [] } }), { jobs: "manual" });
  await t.begin();
  await t.as(scope).run(place, { total: 100 });
  expect(t.jobs.queued.map((d) => d.listener)).toEqual(["o.always"]);
  ran.length = 0;
  expect(await t.jobs.perform(fraud, { total: 100, currency: "EUR" }, { scope })).toEqual("done");
  expect(ran).toEqual([100]);
  await t.rollback();
});
