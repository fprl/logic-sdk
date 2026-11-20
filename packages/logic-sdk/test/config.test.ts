import { z } from "zod";
import { init, type Envelope } from "../src/index.ts";
import { createTestRegistry } from "../src/testing.ts";
import { expect, test } from "bun:test";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null };
type AppConfig = { app: { url: string }; orders: { maxItems: number; currency: "EUR" | "USD" } };
const { query, mutation, action, event, listener, createRegistry } = init<{ scope: Scope; db: Store; config: AppConfig }>();

const seen: Record<string, unknown> = {};
const placed = event({ payload: z.object({ items: z.number() }) });

const limits = query({
  description: "the limits",
  handler: async ({ config }) => {
    seen.query = config;
    return config.orders;
  },
});
const place = mutation({
  description: "place an order",
  input: z.object({ items: z.number() }),
  async handler({ config, emit, errors }, { items }) {
    seen.mutation = config;
    if (items > config.orders.maxItems) throw errors.reject("too_many_items", { max: config.orders.maxItems });
    emit(placed, { items });
    return { link: `${config.app.url}/orders/1` };
  },
});
const checkout = action({
  description: "place, then return the link",
  input: z.object({ items: z.number() }),
  async handler({ config, run }, input) {
    seen.action = config;
    return run(place, input);
  },
});
const receipt = listener({ event: () => placed, description: "Reacts to placed", handler: async ({ config }) => {
  seen.listener = config;
} });
const write = query({
  description: "tries to change config",
  handler: async ({ config }) => {
    (config as any).orders.maxItems = 999;
  },
});

const modules = { orders: { placed, limits, place, checkout, receipt, write } };
const base: AppConfig = { app: { url: "https://shop.test" }, orders: { maxItems: 3, currency: "EUR" } };
const make = (config: AppConfig = base) => createRegistry({ modules, database: memoryDatabase(), config });
const anon = { actor: null };

test("config: the same values in queries, mutations, actions and listeners", async () => {
  for (const k of Object.keys(seen)) delete seen[k];
  const caller = make().as(anon);
  expect(await caller.run(limits)).toEqual({ maxItems: 3, currency: "EUR" });
  expect(await caller.run(checkout, { items: 2 })).toEqual({ link: "https://shop.test/orders/1" });
  expect(Object.keys(seen).sort()).toEqual(["action", "listener", "mutation", "query"]);
  for (const c of Object.values(seen)) expect(c).toEqual(base);
});

test("config: a rule reads it", async () => {
  const error = await make().as(anon).run(place, { items: 4 }).catch((e) => e);
  expect(error.code).toBe("orders.too_many_items");
  expect(error.details).toEqual({ max: 3 });
});

test("config: read-only, and a copy, so nothing changes it under everyone else", async () => {
  const mine = structuredClone(base);
  const registry = make(mine);
  await expect(registry.as(anon).run(write)).rejects.toBeInstanceOf(TypeError); // frozen
  mine.orders.maxItems = 100; // the object you passed stays yours, and the registry doesn't see the change
  expect(Object.isFrozen(mine)).toBe(false);
  expect(await registry.as(anon).run(limits)).toEqual({ maxItems: 3, currency: "EUR" });
});

test("config: plain data only, rejected with the path to the bad value", () => {
  const bad = (app: object) => () => make({ ...base, app } as any);
  expect(bad({ url: "x", client: () => {} })).toThrow("config.app.client is a function. config holds plain data");
  expect(bad({ url: "x", launch: new Date() })).toThrow("config.app.launch is Date"); // as an ISO string instead
  expect(bad({ url: "x", hosts: new Map() })).toThrow("config.app.hosts is Map");
  expect(bad({ url: "x", key: new Uint8Array([1]) })).toThrow("config.app.key is Uint8Array");
  expect(bad({ url: "x", list: [1, new Set()] })).toThrow("config.app.list[1] is Set");
  class Client { url = "x"; }
  expect(bad(new Client())).toThrow("config.app is Client");
});

test("config: arrays are frozen too; merging keeps odd keys and lets null replace a section", async () => {
  const q = query({ description: "raw", handler: async ({ config }) => config as any });
  const registry = createRegistry({
    modules: { orders: { ...modules.orders, q } },
    database: memoryDatabase(),
    config: { ...base, tags: ["a"] } as AppConfig,
  });
  const t = createTestRegistry(registry, { config: JSON.parse('{"__proto__": {"x": 1}, "app": null}') });
  await t.transaction(async (tx) => {
    const c = await tx.as(anon).run(q);
    expect(Object.isFrozen(c.tags)).toBe(true);
    expect(Object.keys(c)).toContain("__proto__"); // an own key, not the prototype
    expect(c.app).toBeNull();
    expect(c.orders.maxItems).toBe(3);
  });
});

test("config: not in event envelopes; a listener reads its registry's config", async () => {
  const t = createTestRegistry(make(), { config: { orders: { maxItems: 5 } } });
  await t.transaction(async (tx) => {
    await tx.as(anon).run(place, { items: 5 });
    const envelope: Envelope = tx.events[0]!;
    expect(Object.keys(envelope).sort()).toEqual(["id", "name", "occurredAt", "payload", "scope"]);
    expect(JSON.stringify(envelope)).not.toContain("shop.test");
    expect((seen.listener as AppConfig).orders.maxItems).toBe(5);
  });
});

test("testing: overrides merge section by section, and only for that test registry", async () => {
  const registry = make();
  const t = createTestRegistry(registry, { config: { orders: { maxItems: 1 } } });
  await t.transaction(async (tx) => {
    expect(await tx.as(anon).run(limits)).toEqual({ maxItems: 1, currency: "EUR" }); // currency kept
    const error = await tx.as(anon).run(place, { items: 2 }).catch((e) => e);
    expect(error.code).toBe("orders.too_many_items");
  });
  expect(await registry.as(anon).run(limits)).toEqual({ maxItems: 3, currency: "EUR" }); // untouched
});

test("config: optional when the app doesn't declare it", async () => {
  const plain = init<{ scope: Scope }>();
  const q = plain.query({ description: "q", handler: async ({ config }) => config });
  expect(await plain.createRegistry({ modules: { m: { q } } }).as(anon).run(q)).toEqual({});
});
