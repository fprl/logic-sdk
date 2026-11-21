import { z } from "zod";
import {
  createRegistry, init, isDomainError, type Call, type Delivery, type DomainError, type Envelope, type FailureInfo,
} from "../src/index.ts";
import { createTestRegistry } from "../src/testing.ts";
import { expect, test } from "bun:test";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null; locale: string };
const { query, mutation, action, event, listener } = init<{ scope: Scope; db: Store; services: { log: string[] } }>();
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

test("action: services available, each mutation commits on its own", async () => {
  const { app, services, db } = setup();
  await app.run(items.greet, { name: "z" });
  expect(services.log).toEqual(["greet z", "added z (items.added, es)"]);
  expect(db.store.rows.items).toEqual([{ name: "z" }]);
});

test("listener failure never fails the caller; goes to onError", async () => {
  const errors: string[] = [];
  const { app, db } = setup({ onError: (e, info) => errors.push(`${info.listener}: ${(e as Error).message}`) });
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

test("wrap sees every call with depth", async () => {
  const calls: string[] = [];
  const { app } = setup({ wrap: async (c: Call, next) => { calls.push(`${c.depth}:${c.kind}:${c.id}`); return next(); } });
  await app.run(items.addTwo, { a: "a", b: "b" });
  expect(calls).toEqual(["0:mutation:items.addTwo", "1:mutation:items.add", "1:mutation:items.add", "0:listener:log.onAdded", "0:listener:log.onAdded"]);
});

test("custom dispatcher: one delivery per listener, enqueued inside the transaction, delivered after", async () => {
  const seen: string[] = [];
  const { app } = setup({
    jobs: { adapter: {
      async enqueue(tx, deliveries) { seen.push(`enqueue ${deliveries.map((d) => `${d.envelope.name}→${d.listener}`)} in tx=${tx !== undefined}`); },
      async deliver(deliveries, { run }) { seen.push("deliver"); for (const d of deliveries) seen.push(await run(d)); },
    } },
  });
  await app.run(items.add, { name: "q" });
  expect(seen).toEqual(["enqueue items.added→log.onAdded in tx=true", "deliver", "done"]);
});

test("deliveries are JSON: what a queue carries comes back and runs", async () => {
  const deliveries: Delivery[] = [];
  const { app, registry } = setup({ jobs: { adapter: { async deliver(d) { deliveries.push(...d); } } } });
  await app.run(items.add, { name: "j" });
  const d: Delivery = JSON.parse(JSON.stringify(deliveries[0]));
  expect(d).toMatchObject({ listener: "log.onAdded", envelope: { name: "items.added", depth: 1, scope: { locale: "es" }, payload: { name: "j" } } });
  expect(d).toMatchObject({ kind: "delivery", id: `log.onAdded@${d.envelope.id}` });
  expect(await registry.jobs.run(d, { attempt: 2 })).toEqual("done");
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
    jobs: { adapter: { deliver: async (deliveries) => void seen.push(...deliveries.map((d) => d.envelope)) } },
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
  await t.transaction(async (tx) => {
    const app = tx.as({ actor: "ana", locale: "es" });
    await app.run(items.add, { name: "inside" });
    expect(tx.events.map((e) => [e.name, e.occurredAt])).toEqual([["items.added", "2026-07-01T10:00:00.000Z"]]);
    expect((tx.db as Store).rows.items).toEqual([{ name: "inside" }]);
    tx.stub(items.add, async () => ({ name: "stubbed" }));
    expect(await app.run(items.greet, { name: "x" })).toEqual({ name: "stubbed" });
  });
  expect(db.store.rows.items).toEqual(undefined);
});

test("testing: a failing mutation inside a test rolls back only itself", async () => {
  const { registry } = setup();
  await createTestRegistry(registry).transaction(async (tx) => {
    const app = tx.as({ actor: "ana", locale: "es" });
    await app.run(items.add, { name: "keep" });
    await expect(app.run(items.add, { name: "boom" })).rejects.toThrow();
    expect((tx.db as Store).rows.items).toEqual([{ name: "keep" }]);
  });
});

test("testing: listeners: false isolates a module", async () => {
  const { registry } = setup();
  const services = { log: [] as string[] };
  await createTestRegistry(registry, { listeners: false, services }).transaction(async (tx) => {
    await tx.as({ actor: "a", locale: "es" }).run(items.add, { name: "iso" });
    expect(services.log).toEqual([]);
    expect(tx.events.length).toEqual(1);
  });
});

test("long-lived process: concurrent requests never see each other's scope", async () => {
  const { registry } = setup();
  const slow = query({
    input: z.object({ ms: z.number() }),
    handler: async ({ scope, run }, { ms }) => {
      await new Promise((r) => setTimeout(r, ms));
      return [scope.actor, await run(locale)];
    },
  });
  const d = createRegistry<Scope>({ modules: { items, log, slow: { slow } }, database: memoryDatabase() });
  void registry;
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

test("review #1: invalid emit + throw rejects cleanly, no unhandled rejection", async () => {
  const { app } = regSetup();
  await expect(app.run(reg.badEmitThenThrow, {})).rejects.toMatchObject({ code: "reg.boom" });
  await tick();
  expect(unhandled.length).toEqual(0);
});

test("review #2: errors after commit never reach the caller (throwing onError, throwing waitUntil)", async () => {
  const { app, db } = regSetup({ onError: () => { throw new Error("onError exploded"); } });
  const quiet = console.error; console.error = () => {};
  try {
    expect(await app.run(add, { name: "listener-fails" })).toEqual({ name: "listener-fails" });
    const { app: app2 } = regSetup({ waitUntil: () => { throw new TypeError("Illegal invocation"); } });
    expect(await app2.run(add, { name: "w" })).toEqual({ name: "w" });
  } finally { console.error = quiet; }
  expect(db.store.rows.items).toEqual([{ name: "listener-fails" }]);
});

test("review #3: emit takes the schema's input, listeners get its output", async () => {
  const { app } = regSetup();
  seen.length = 0;
  await app.run(reg.stamp, { at: "2026-07-01T00:00:00Z" });
  expect(seen[0]!.at instanceof Date).toBe(true);
});

test("review #4: a caught nested `throw undefined` still dooms the transaction", async () => {
  const { app, db } = regSetup();
  await expect(app.run(reg.swallowsUndefined, {})).rejects.toThrow();
  expect(db.store.rows.t).toEqual(undefined);
});

test("review #6: a caught nested invalid-input failure dooms the transaction too", async () => {
  const { app, db } = regSetup();
  await expect(app.run(reg.swallowsBadInput, {})).rejects.toThrow(/run with invalid input/);
  expect(db.store.rows.t).toEqual(undefined);
});

test("registry.jobs.sweep runs the transport's sweep with jobs.run; in-process has nothing to sweep", async () => {
  const { registry } = setup();
  expect(await registry.jobs.sweep()).toEqual({ done: 0, failed: 0, discarded: 0, retrying: 0 });
  let got: { limit?: number } | undefined;
  const { registry: swept } = setup({ jobs: { adapter: { deliver: async () => {}, sweep: async (runner, options) => { got = options; expect(runner.run).toBe(swept.jobs.run); return { done: 2, failed: 0, discarded: 0, retrying: 1 }; } } } });
  expect(await swept.jobs.sweep({ limit: 5 })).toEqual({ done: 2, failed: 0, discarded: 0, retrying: 1 });
  expect(got).toEqual({ limit: 5 });
});

test("registry.jobs.retry: the transport's answer, or a throw when it stores no jobs", async () => {
  const { registry } = setup();
  await expect(registry.jobs.retry("log.onAdded@e1")).rejects.toThrow(/stores no jobs, so there's nothing to retry \(log\.onAdded@e1\)/);
  const asked: string[] = [];
  const { registry: stored } = setup({ jobs: { adapter: { deliver: async () => {}, retry: async (id) => (asked.push(id), id === "known") } } });
  expect(await stored.jobs.retry("known")).toBe(true);
  expect(await stored.jobs.retry("other")).toBe(false);
  expect(asked).toEqual(["known", "other"]);
});

test("registry.jobs.run: done, failed for good, or throws to retry", async () => {
  const reported: FailureInfo[] = [];
  const { d } = regSetup({ onError: (_e, info) => reported.push(info) });
  const envelope = { id: "e1", name: "items.added", payload: { name: "fine" }, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 };
  const delivery = (payload: object, listener = "log.onAdded") => ({ kind: "delivery" as const, id: `${listener}@e1`, listener, envelope: { ...envelope, payload } });
  expect(await d.jobs.run(delivery({ name: "fine" }))).toEqual("done");
  // an unexpected error: a retry might help, so it throws (the queue redelivers)
  await expect(d.jobs.run(delivery({ name: "listener-fails" }), { attempt: 3 })).rejects.toThrow(/listener exploded/);
  expect(reported.at(-1)).toMatchObject({ listener: "log.onAdded", delivery: "log.onAdded@e1", attempt: 3 });
  // a payload that no longer matches its schema: retrying can't help
  expect(await d.jobs.run(delivery({ nope: 1 }))).toEqual("failed");
  // a renamed or removed listener throws, so the message ends in the dead-letter queue
  await expect(d.jobs.run(delivery({ name: "fine" }, "log.gone"))).rejects.toThrow(/log\.gone isn't a registered listener/);
});

test("a listener's domain error is final (failed, reported); a conflict throws to retry", async () => {
  const happened = event({ payload: z.object({ kind: z.string() }) });
  const react = listener({
    event: () => happened,
    async handler(ctx, { kind }) {
      if (kind === "gone") throw ctx.errors.notFound();
      if (kind === "taken") throw ctx.errors.conflict("taken");
    },
  });
  const errors: string[] = [];
  const r = createRegistry<Scope>({ modules: { x: { happened, react } }, database: memoryDatabase(), onError: (e) => errors.push((e as Error).message) });
  const delivery = (kind: string) => ({ kind: "delivery" as const, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: { kind }, scope: { actor: "a", locale: "es" }, occurredAt: "", depth: 1 } });
  expect(await r.jobs.run(delivery("gone"))).toEqual("failed");
  await expect(r.jobs.run(delivery("taken"))).rejects.toMatchObject({ kind: "conflict" });
  expect(errors).toHaveLength(2);
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
  expect(Object.keys(seen!).sort()).toEqual(["attempt", "id", "name", "occurredAt", "payload"]);
});

test("listener loops stop at maxEventDepth and are reported, not thrown", async () => {
  const ping = event({ payload: z.object({ n: z.number() }) });
  const bump = mutation({ input: z.object({ n: z.number() }), handler: async ({ emit }, { n }) => emit(ping, { n }) });
  const loop = listener({ event: () => ping, handler: async ({ run }, { n }) => { await run(bump, { n: n + 1 }); } });
  const errors: string[] = [];
  const d = createRegistry<Scope>({ modules: { l: { ping, bump, loop } }, database: memoryDatabase(), maxEventDepth: 5, onError: (e) => errors.push((e as Error).message) });
  await d.as({ actor: "a", locale: "es" }).run(bump, { n: 0 });
  expect(errors.length).toEqual(1);
  expect(/event chain deeper than 5/.test(errors[0]!)).toBe(true);
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

test("retries stop after `attempts`, and errors that aren't retryable are never retried", async () => {
  let calls = 0;
  const db = memoryDatabase();
  const alwaysDeadlocks = { ...db, retryable: () => true,
    transaction: async () => { calls++; throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); } };
  const r = createRegistry<Scope>({ modules: { items, log }, database: alwaysDeadlocks, services: { log: [] }, retry: { attempts: 2 } });
  await expect(r.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(2);

  calls = 0;
  const r2 = createRegistry<Scope>({ modules: { items, log }, database: { ...alwaysDeadlocks, retryable: () => false }, services: { log: [] } });
  await expect(r2.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(1);
});

test("the default listener-loop limit is 8 hops", async () => {
  const ping = event({ payload: z.object({ n: z.number() }) });
  const bump = mutation({ input: z.object({ n: z.number() }), handler: async ({ emit }, { n }) => emit(ping, { n }) });
  const hops: number[] = [];
  const loop = listener({ event: () => ping, handler: async ({ run }, { n }) => { hops.push(n); await run(bump, { n: n + 1 }); } });
  const errors: string[] = [];
  const d = createRegistry<Scope>({ modules: { l: { ping, bump, loop } }, database: memoryDatabase(), onError: (e) => errors.push((e as Error).message) });
  await d.as({ actor: "a", locale: "es" }).run(bump, { n: 0 });
  expect(hops.length).toEqual(8);
  expect(errors[0]).toMatch(/deeper than 8/);
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
    jobs: { adapter: { async deliver(d, { run }) { jobs.push(...d); for (const j of d) await run(j); } } },
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
      adapter: { async deliver(d, { run }) { for (const j of d) { stored.push(j.envelope.scope); outcomes.push(await run(j)); } } },
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
  const react = listener({ event: () => happened, async handler() {} });
  const make = (scope: object) => createRegistry<Scope>({ modules: { x: { happened, doIt, react } }, database: memoryDatabase(), onError: () => {}, jobs: { scope } });
  await expect(make({ store: () => ({ at: new Date() }), load: () => null }).as({ actor: "a", locale: "es" }).run(doIt)).rejects.toThrow(/scope emitting x\.happened isn't plain data at at: a Date/);
  const flaky = make({ load: async () => { throw new Error("db down"); } });
  const job = { kind: "delivery" as const, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  await expect(flaky.jobs.run(job)).rejects.toThrow("db down");
});

test("a job of a kind this version doesn't know throws, so the queue keeps it", async () => {
  const { registry } = setup({ onError: () => {} });
  const job = { kind: "call", id: "x", listener: "log.onAdded", envelope: { id: "e", name: "items.added", payload: { name: "a" }, scope: {}, occurredAt: "", depth: 1 } };
  await expect(registry.jobs.run(job as never)).rejects.toThrow(/job x has kind "call", which this version can't run/);
});

test("jobs.scope types: load gets what store saved, and returns the app's scope", () => {
  const m = init<{ scope: Scope }>();
  m.createRegistry({
    modules: {},
    jobs: {
      scope: {
        store: (s) => ({ who: s.actor }),
        load: (saved) => {
          // @ts-expect-error: only what store saved
          void saved.locale;
          return { actor: saved.who, locale: "es" };
        },
      },
    },
  });
  m.createRegistry({
    modules: {},
    jobs: {
      scope: {
        // load first: annotate its parameter, since TypeScript reads the object in order (or write store first)
        load: (saved: { who: string | null }) => ({ actor: saved.who, locale: "es" }),
        store: (s) => ({ who: s.actor }),
      },
    },
  });
  m.createRegistry({
    modules: {},
    // @ts-expect-error: load must return the app's scope (or null)
    jobs: { scope: { load: () => ({ nope: 1 }) } },
  });
});

test("jobs.scope: store without load throws; load returning undefined retries instead of discarding", async () => {
  expect(() => createRegistry({ modules: {}, jobs: { scope: { store: (s: object) => s } as never } })).toThrow("jobs.scope has store but no load");
  const happened = event({ payload: z.object({}) });
  const react = listener({ event: () => happened, async handler() {} });
  const r = createRegistry<Scope>({ modules: { x: { happened, react } }, onError: () => {}, jobs: { scope: { load: (() => undefined) as never } } });
  const job = { kind: "delivery" as const, id: "x.react@e", listener: "x.react", envelope: { id: "e", name: "x.happened", payload: {}, scope: {}, occurredAt: "", depth: 1 } };
  await expect(r.jobs.run(job)).rejects.toThrow(/load returned undefined for x\.react@e\. Return the scope, or null to discard/);
});
