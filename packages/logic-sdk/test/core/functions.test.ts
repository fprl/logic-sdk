// Calls: input and output, kinds, scope, actions, ctx errors, private functions, nesting.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, isDomainError, type DomainError } from "../../src/index.ts";
import { action, add, items, locale, log, mutation, query, setup, signedIn, type Scope } from "../support/app.ts";
import { memoryDatabase } from "../support/memory-db.ts";

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

test("run options: { scope } changes who is calling for that call, and checks see it", async () => {
  const asAdmin = action({
    input: z.object({ name: z.string() }),
    handler: async ({ run, scope }, { name }) => run(add, { name }, { scope: { ...scope, actor: "system" } }),
  });
  const r = createRegistry<Scope>({ modules: { items, log, x: { asAdmin } }, database: { adapter: memoryDatabase() }, services: { log: [] } });
  expect(await r.as({ actor: null, locale: "es" }).run(asAdmin, { name: "z" })).toEqual({ name: "z" });
});

test("bad input on a nested run is a bug in your code (plain Error), not the caller's 400", async () => {
  const outer = mutation({ input: z.object({}), handler: async ({ run }) => run(add, { name: "" }) });
  const r = createRegistry<Scope>({ modules: { items, log, o: { outer } }, database: { adapter: memoryDatabase() }, services: { log: [] } });
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
  expect(await app.run(items.locale, undefined, { scope: { actor: "ana", locale: "fr" } })).toEqual("fr");
  expect(await app.run(items.locale)).toEqual("es");
});

test("kinds: a query can't run a mutation (runtime guard behind the type)", async () => {
  const { app } = setup();
  const bad = query({
    // @ts-expect-error queries can only run queries
    handler: async ({ run }) => run(items.add, { name: "x" }),
  });
  const d = createRegistry<Scope>({ modules: { items, bad: { bad } }, database: { adapter: memoryDatabase() } });
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
  const r = createRegistry<Scope>({ modules: { items, log, x: { twoSteps } }, database: { adapter: own }, services: { log: [] } });
  await expect(r.as({ actor: "a", locale: "es" }).run(twoSteps)).rejects.toMatchObject({ code: "items.boom" });
  expect(own.store.rows.items).toEqual([{ name: "first" }]);
});

test("output strips keys the schema doesn't name, so a returned row can't leak a column", async () => {
  const row = { name: "a", passwordHash: "x" }; // what a select * returns
  const leaky = query({ output: z.object({ name: z.string() }), handler: async () => row });
  const r = createRegistry<Scope>({ modules: { x: { leaky } }, database: { adapter: memoryDatabase() } });
  expect(await r.as({ actor: "a", locale: "es" }).run(leaky)).toEqual({ name: "a" });
});

test("ctx.run nests 64 deep, and a function that runs itself fails fast with the path", async () => {
  const countdown = query({ input: z.number(), handler: async ({ run }, n): Promise<number> => (n === 0 ? 0 : run(countdown, n - 1)) });
  const ping = query({ handler: async ({ run }): Promise<never> => run(pong) });
  const pong = query({ handler: async ({ run }): Promise<never> => run(ping) });
  const app = createRegistry<Scope>({ modules: { a: { countdown, ping }, b: { pong } } }).as({ actor: "ana", locale: "es" });
  expect(await app.run(countdown, 64)).toBe(0);
  await expect(app.run(countdown, 65)).rejects.toThrow("ctx.run nested past 64 calls: … → a.countdown → a.countdown");
  await expect(app.run(ping)).rejects.toThrow(
    "ctx.run nested past 64 calls: … → b.pong → a.ping → b.pong → a.ping → b.pong → a.ping → b.pong. Recurse in a plain helper",
  );
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
  const r = createRegistry<Scope>({ modules: { items, log, x: { twoSteps } }, database: { adapter: memoryDatabase() }, services: { log: [] } });
  expect(await r.as({ actor: "a", locale: "es" }).run(twoSteps, undefined, { signal: ctrl.signal })).toBe("done");
  expect(seen).toEqual([ctrl.signal]); // actions get it as ctx.signal, to pass on to fetch
});

test("a private function (its index doesn't export it) runs through ctx.run as part of its caller's module", async () => {
  const record = mutation({
    input: z.object({ name: z.string() }),
    authorize: signedIn,
    async handler({ db, errors }, { name }) {
      if (name === "taken") throw errors.conflict("taken");
      (db.rows.files ??= []).push({ name });
      return name;
    },
  });
  const count = query({ id: "count", handler: async ({ db }) => (db.rows.files ?? []).length });
  const upload = action({ input: z.object({ name: z.string() }), handler: async ({ run }, input) => ({ name: await run(record, input), count: await run(count) }) });
  const later = mutation({ handler: async ({ schedule }) => void schedule(record, { name: "x" }, { delay: 0 }) });
  const calls: string[] = [];
  const registry = createRegistry<Scope>({ modules: { files: { upload, later } }, database: { adapter: memoryDatabase() }, wrap: async (c, next) => { calls.push(c.id); return next(); } });
  const ana = registry.as({ actor: "ana", locale: "es" });

  expect(await ana.run(upload, { name: "a" })).toEqual({ name: "a", count: 1 });
  expect(calls).toEqual(["files.upload", "files.(private)", "files.count"]);
  await expect(ana.run(upload, { name: "taken" })).rejects.toMatchObject({ code: "files.taken" });
  await expect(registry.as({ actor: null, locale: "es" }).run(upload, { name: "b" })).rejects.toMatchObject({ code: "files.forbidden" });
  // anything that finds code by name refuses it: here from outside, and when scheduled
  await expect(ana.run(record, { name: "c" })).rejects.toThrow(/runs only through ctx.run/);
  await expect(ana.run(later)).rejects.toThrow(/ctx.schedule needs a function its module's index.ts exports/);
  // createRegistry can't see a private mutation, so its missing database is caught when it runs
  const viaAction = action({ handler: ({ run }) => run(mutation({ handler: async () => 1 })) });
  await expect(createRegistry<Scope>({ modules: { x: { viaAction } } }).as({ actor: "ana", locale: "es" }).run(viaAction)).rejects.toThrow(/Mutations need a database/);
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
  const app = createRegistry<Scope>({ modules: { slots: { take }, booking: { tryTake } }, database: { adapter: memoryDatabase() } }).as({ actor: "a", locale: "es" });
  expect(await app.run(tryTake, {})).toEqual("fallback");
});

test("long-lived process: concurrent requests never see each other's scope", async () => {
  const slow = query({
    input: z.object({ ms: z.number() }),
    handler: async ({ scope, run }, { ms }) => {
      await new Promise((r) => setTimeout(r, ms));
      return [scope.actor, await run(locale)];
    },
  });
  const d = createRegistry<Scope>({ modules: { items, log, slow: { slow } }, database: { adapter: memoryDatabase() } });
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      d.as({ actor: `u${i}`, locale: `l${i}` }).run(slow, { ms: (i * 7) % 13 }),
    ),
  );
  results.forEach((r, i) => expect(r).toEqual([`u${i}`, `l${i}`]));
});
