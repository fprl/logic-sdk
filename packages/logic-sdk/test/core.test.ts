import { z } from "zod";
import {
  createRegistry, init, isDomainError, type Call, type DomainError, type Envelope,
} from "../src/index.ts";
import { createTestRegistry } from "../src/testing.ts";
import { expect, test } from "bun:test";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null; locale: string };
const { query, mutation, action, event, on } = init<{ scope: Scope; db: Store; services: { log: string[] } }>();
const anyone = () => true;
const signedIn = (s: Scope): s is Scope & { actor: string } => s.actor !== null;

// ── a tiny two-module registry (separate consts, like real module files) ─────
const added = event({ payload: z.object({ name: z.string() }) });

const list = query({
  description: "list",
  input: z.object({}).optional(),
  authorize: anyone,
  expose: true,
  output: z.array(z.string()),
  handler: async ({ db }) => (db.rows.items ?? []).map((r) => r.name as string),
});
const add = mutation({
  description: "add",
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
  description: "add two, swallowing the failure of the second",
  input: z.object({ a: z.string(), b: z.string() }),
  async handler({ run }, { a, b }) {
    await run(add, { name: a });
    try { await run(add, { name: b }); } catch { /* caught, but the transaction is doomed */ }
    return "done";
  },
});
const typed = mutation({
  description: "output schema",
  input: z.object({ n: z.number() }),
  output: z.object({ doubled: z.number().max(10) }),
  handler: async (_, { n }) => ({ doubled: n * 2 }),
});
const locale = query({ description: "locale", handler: async ({ scope }) => scope.locale });
const whoami = query({
  description: "scope echo",
  handler: async ({ scope, run }) => ({
    outer: scope.locale,
    inner: await run(locale, undefined, { scope: { locale: "en" } }),
    nested: await run(locale),
  }),
});
const greet = action({
  description: "action with services",
  input: z.object({ name: z.string() }),
  async handler({ run, services }, { name }) {
    services.log.push(`greet ${name}`);
    return run(add, { name });
  },
});
const items = { added, list, add, addTwo, typed, locale, whoami, greet };

const onAdded = on(() => added, async ({ services, event, scope }, { name }) => {
  if (name === "listener-fails") throw new Error("listener exploded");
  services.log.push(`added ${name} (${event.name}, ${scope.locale})`);
});
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
  expect(registry.functions.map((f) => f.id).sort()).toEqual([
    "items.add", "items.addTwo", "items.greet", "items.list", "items.locale", "items.typed", "items.whoami",
  ]);
  expect(registry.listeners.map((l) => l.id)).toEqual(["log.onAdded"]);
  expect(registry.functions.filter((f) => f.exposed).map((f) => f.id).sort()).toEqual(["items.add", "items.list"]);
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
    description: "runs add as someone else",
    input: z.object({ name: z.string() }),
    handler: async ({ run }, { name }) => run(add, { name }, { scope: { actor: "system" } }),
  });
  const r = createRegistry<Scope>({ modules: { items, log, x: { asAdmin } }, database: memoryDatabase(), services: { log: [] } });
  expect(await r.as({ actor: null, locale: "es" }).run(asAdmin, { name: "z" })).toEqual({ name: "z" });
});

test("expose: true without authorize or output fails when the function is defined", () => {
  const msg = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
  // @ts-expect-error expose without authorize
  expect(msg(() => query({ description: "x", output: z.number(), expose: true, handler: async () => 1 }))).toMatch(/no authorize/);
  // @ts-expect-error expose without output
  expect(msg(() => query({ description: "x", authorize: anyone, expose: true, handler: async () => 1 }))).toMatch(/no output/);
  // @ts-expect-error a policy name is not a policy
  expect(msg(() => query({ description: "x", authorize: "staff", handler: async () => 1 }))).toMatch(/must be a policy function/);
});

test("a policy must return exactly true, and must be sync", async () => {
  const truthy = query({ description: "truthy policy", authorize: (() => "yes") as any, handler: async () => 1 });
  const asyncy = query({ description: "async policy", authorize: (async () => true) as any, handler: async () => 1 });
  const r = createRegistry<Scope>({ modules: { p: { truthy, asyncy } }, database: memoryDatabase() });
  const app = r.as({ actor: "a", locale: "es" });
  await expect(app.run(truthy)).rejects.toMatchObject({ kind: "forbidden", code: "p.truthy.forbidden" });
  const err = await app.run(asyncy).catch((e: unknown) => e);
  expect(isDomainError(err)).toBe(false);
  expect(err).toHaveProperty("message", expect.stringMatching(/returned a Promise/));
});

test("an internal function with authorize is checked too, even when your own code runs it", async () => {
  const purge = mutation({ description: "admin only", input: z.object({}), authorize: signedIn, handler: async () => "purged" });
  const job = action({ description: "a job", input: z.object({}), handler: async ({ run }) => run(purge, {}) });
  const r = createRegistry<Scope>({ modules: { j: { purge, job } }, database: memoryDatabase(), services: { log: [] } });
  expect(r.functions.find((f) => f.id === "j.purge")!.exposed).toBe(false);
  await expect(r.as({ actor: null, locale: "es" }).run(job, {})).rejects.toMatchObject({ kind: "forbidden", code: "j.purge.forbidden" });
  expect(await r.as({ actor: "a", locale: "es" }).run(job, {})).toEqual("purged");
});

test("bad input on a nested run is a bug in your code (plain Error), not the caller's 400", async () => {
  const outer = mutation({ description: "passes bad input on", input: z.object({}), handler: async ({ run }) => run(add, { name: "" }) });
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
    description: "bad",
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

test("custom dispatcher: enqueue inside the transaction, deliver after", async () => {
  const seen: string[] = [];
  const { app } = setup({
    events: {
      async enqueue(tx, envs) { seen.push(`enqueue ${envs.map((e) => e.name)} in tx=${tx !== undefined}`); },
      async deliver(envs: Envelope[], dispatch) { seen.push("deliver"); for (const e of envs) await dispatch(e); },
    },
  });
  await app.run(items.add, { name: "q" });
  expect(seen).toEqual(["enqueue items.added in tx=true", "deliver"]);
});

test("envelopes are JSON-serializable", async () => {
  const envs: Envelope[] = [];
  const { app } = setup({ events: { async deliver(e) { envs.push(...e); } } });
  await app.run(items.add, { name: "j" });
  const e = JSON.parse(JSON.stringify(envs[0]));
  expect(typeof e.id === "string" && e.name === "items.added" && e.scope.locale === "es" && e.payload.name === "j").toBe(true);
});

test("abort signal: checked before the call starts, never between its steps", async () => {
  const { registry } = setup();
  const app = registry.as({ actor: "a", locale: "es" });
  const aborted = AbortSignal.abort();
  await expect(app.run(items.list, undefined, { signal: aborted })).rejects.toThrow();

  const ctrl = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const twoSteps = action({
    description: "two steps; the caller gives up after the first",
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
    description: "add as the system",
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
    events: { deliver: async (envelopes: Envelope[]) => void seen.push(...envelopes) },
  });
  await r.as({ actor: "ana", locale: "es" }).run(emits, { name: "z" });
  expect(seen.map((e) => e.scope)).toEqual([{ actor: "system", locale: "es" }]);
});

test("guards: unregistered functions and missing database", async () => {
  const stray = query({ description: "x", handler: async () => 1 });
  const { app } = setup();
  await expect(app.run(stray)).rejects.toThrow(/isn't registered/);
  let threw = false;
  try { createRegistry({ modules: { items } }); } catch (e) { threw = /database adapter/.test((e as Error).message); }
  expect(threw).toBe(true);
});

test("ctx errors are namespaced to the module they're thrown from", async () => {
  const fails = query({
    description: "throws the kind it's asked for",
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
  const take = mutation({ description: "always taken", input: z.object({}), handler: async ({ errors }) => { throw errors.conflict("taken"); } });
  const tryTake = action({
    description: "falls back when taken",
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
    description: "slow echo",
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
    description: "emit an invalid payload, then throw",
    input: z.object({}),
    async handler({ emit, errors }) {
      emit(stamped, { at: 42 as unknown as string });
      throw errors.reject("boom");
    },
  }),
  stamp: mutation({
    description: "emit with a transforming schema",
    input: z.object({ at: z.string() }),
    async handler({ emit }, { at }) { emit(stamped, { at }); },
  }),
  throwsUndefined: mutation({
    description: "throws undefined",
    input: z.object({}),
    async handler({ db }) { (db.rows.t ??= []).push("inner"); throw undefined; },
  }),
  swallowsUndefined: mutation({
    description: "catches a nested undefined throw",
    input: z.object({}),
    async handler({ db, run }) {
      (db.rows.t ??= []).push("outer");
      try { await run(reg.throwsUndefined, {}); } catch {}
      return "ok";
    },
  }),
  swallowsBadInput: mutation({
    description: "catches a nested invalid-input failure",
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
const regListeners = { onStamped: on(() => stamped, async (_, payload) => { seen.push(payload); }) };

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

test("review #7: registry.dispatch throws when a listener fails (durable consumers can retry)", async () => {
  const { d } = regSetup();
  const envelope = { id: "e1", name: "items.added", payload: { name: "listener-fails" }, scope: { actor: "a", locale: "es" }, occurredAt: "" };
  await expect(d.dispatch(envelope)).rejects.toThrow(/log\.onAdded/);
  await d.dispatch({ ...envelope, payload: { name: "fine" } });
});

test("listener loops stop at maxEventDepth and are reported, not thrown", async () => {
  const ping = event({ payload: z.object({ n: z.number() }) });
  const bump = mutation({ description: "re-emit", input: z.object({ n: z.number() }), handler: async ({ emit }, { n }) => emit(ping, { n }) });
  const loop = on(() => ping, async ({ run }, { n }) => { await run(bump, { n: n + 1 }); });
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
  const bump = mutation({ description: "re-emit", input: z.object({ n: z.number() }), handler: async ({ emit }, { n }) => emit(ping, { n }) });
  const hops: number[] = [];
  const loop = on(() => ping, async ({ run }, { n }) => { hops.push(n); await run(bump, { n: n + 1 }); });
  const errors: string[] = [];
  const d = createRegistry<Scope>({ modules: { l: { ping, bump, loop } }, database: memoryDatabase(), onError: (e) => errors.push((e as Error).message) });
  await d.as({ actor: "a", locale: "es" }).run(bump, { n: 0 });
  expect(hops.length).toEqual(8);
  expect(errors[0]).toMatch(/deeper than 8/);
});

test("meta is set per function and visible in wrap and the registry", async () => {
  const m = init<{ scope: Scope; meta: { tags: string[] } }>();
  const tagged = m.query({ description: "tagged", meta: { tags: ["billing"] }, handler: async () => 1 });
  const seen: unknown[] = [];
  const r = m.createRegistry({ modules: { billing: { tagged } }, wrap: async (call, next) => { seen.push(call.meta?.tags); return next(); } });
  await r.as({ actor: "a", locale: "es" }).run(tagged);
  expect(seen).toEqual([["billing"]]);
  expect(r.functions.find((f) => f.id === "billing.tagged")?.fn.meta).toEqual({ tags: ["billing"] });
});

test("emit snapshots the payload: mutating it afterwards changes nothing", async () => {
  const got: string[] = [];
  const happened = event({ payload: z.object({ name: z.string() }) });
  const doIt = mutation({ description: "emit then mutate", input: z.object({}), async handler({ emit }) {
    const payload = { name: "before" };
    emit(happened, payload);
    payload.name = "after";
  } });
  const listen = on(() => happened, async (_, { name }) => { got.push(name); });
  await createRegistry<Scope>({ modules: { x: { happened, doIt, listen } }, database: memoryDatabase() }).as({ actor: "a", locale: "es" }).run(doIt, {});
  expect(got).toEqual(["before"]);
});
