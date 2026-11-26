// The registry: ids, guards, wrap and meta.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry, init, type Call, type Delivery, type DomainError } from "../../src/index.ts";
import { add, deliveriesIn, event, items, listener, mutation, query, regSetup, setup, type Scope } from "../support/app.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

test("registry: ids come from module keys", () => {
  const { registry } = setup();
  expect(registry.definitions.functions.map((f) => f.id).sort()).toEqual([
    "items.add", "items.addTwo", "items.greet", "items.list", "items.locale", "items.typed", "items.whoami",
  ]);
  expect(registry.definitions.listeners.map((l) => l.id)).toEqual(["log.onAdded"]);
});

test("wrap sees every call with depth", async () => {
  const calls: string[] = [];
  const { app } = setup({ wrap: async (c: Call, next) => { calls.push(`${c.depth}:${c.kind}:${c.id}`); return next(); } });
  await app.run(items.addTwo, { a: "a", b: "b" });
  expect(calls).toEqual(["0:mutation:items.addTwo", "1:mutation:items.add", "1:mutation:items.add", "0:listener:log.onAdded", "0:listener:log.onAdded"]);
});

test("guards: unregistered functions and missing database", async () => {
  const stray = query({ handler: async () => 1 });
  const { app } = setup();
  await expect(app.run(stray)).rejects.toThrow(/isn't registered/);
  let threw = false;
  try { createRegistry({ modules: { items } }); } catch (e) { threw = /Mutations need a database/.test((e as Error).message); }
  expect(threw).toBe(true);
});

test("wrap sees calls that fail validation or authorization (audit trails include denials)", async () => {
  const calls: string[] = [];
  const { d } = regSetup({ wrap: async (c, next) => { try { return await next(); } catch (e) { calls.push(`${c.id}:${(e as DomainError).kind}`); throw e; } } });
  await expect(d.as({ actor: null, locale: "es" }).run(add, { name: "x" })).rejects.toThrow();
  // @ts-expect-error invalid on purpose
  await expect(d.as({ actor: "a", locale: "es" }).run(add, { name: 1 })).rejects.toThrow();
  expect(calls).toEqual(["items.add:forbidden", "items.add:invalid"]);
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
    database: { adapter: memoryDatabase() },
    wrap: async (call, next) => { seen.push(`${call.kind}:${call.meta?.tags ?? "-"}`); return next(); },
  });
  await r.as({ actor: "a", locale: "es" }).run(doIt);
  expect(seen).toEqual(["mutation:-", "listener:audit"]);
});

test("ids: an explicit id is local to its module, and jobs store it", async () => {
  const happened = event({ id: "happened", payload: z.object({}) });
  const doIt = mutation({ id: "do", async handler(ctx) { ctx.emit(happened, {}); } });
  const ran: string[] = [];
  const send = listener({ id: "send", event: () => happened, handler: async () => void ran.push("send") });
  const jobs: Delivery[] = [];
  const r = createRegistry<Scope>({
    modules: { notifications: { renamedEvent: happened, renamedFn: doIt, renamedListener: send } },
    database: { adapter: memoryDatabase() },
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
