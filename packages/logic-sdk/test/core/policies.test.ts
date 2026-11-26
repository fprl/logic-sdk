// Policies: `authorize` on every call, before validation, before a transaction opens.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry } from "../../src/index.ts";
import { action, add, items, log, mutation, query, regSetup, setup, signedIn, type Scope } from "../support/app.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

test("a function's check runs on every call, nested ones too", async () => {
  const { registry, db } = setup();
  const anon = registry.as({ actor: null, locale: "es" });
  await expect(anon.run(items.add, { name: "x" })).rejects.toMatchObject({ kind: "forbidden", code: "items.add.forbidden" });
  // greet is internal (no check), but the add it runs has a policy: still checked, so a narrowed scope never lies
  await expect(anon.run(items.greet, { name: "y" })).rejects.toMatchObject({ kind: "forbidden" });
  expect(db.store.rows.items).toEqual(undefined);
});

test("a policy must return exactly true: truthy or a Promise is a denial", async () => {
  const truthy = query({ authorize: (() => "yes") as any, handler: async () => 1 });
  const asyncy = query({ authorize: (async () => true) as any, handler: async () => 1 });
  const r = createRegistry<Scope>({ modules: { p: { truthy, asyncy } }, database: { adapter: memoryDatabase() } });
  const app = r.as({ actor: "a", locale: "es" });
  await expect(app.run(truthy)).rejects.toMatchObject({ kind: "forbidden", code: "p.truthy.forbidden" });
  await expect(app.run(asyncy)).rejects.toMatchObject({ kind: "forbidden", code: "p.asyncy.forbidden" });
});

test("an internal function with authorize is checked too, even when your own code runs it", async () => {
  const purge = mutation({ input: z.object({}), authorize: signedIn, handler: async () => "purged" });
  const job = action({ input: z.object({}), handler: async ({ run }) => run(purge, {}) });
  const r = createRegistry<Scope>({ modules: { j: { purge, job } }, database: { adapter: memoryDatabase() }, services: { log: [] } });
  await expect(r.as({ actor: null, locale: "es" }).run(job, {})).rejects.toMatchObject({ kind: "forbidden", code: "j.purge.forbidden" });
  expect(await r.as({ actor: "a", locale: "es" }).run(job, {})).toEqual("purged");
});

test("authorize runs before validation: anonymous callers never see a protected function's schema errors", async () => {
  const { d } = regSetup();
  // @ts-expect-error invalid on purpose
  await expect(d.as({ actor: null, locale: "es" }).run(add, { name: 1 })).rejects.toMatchObject({ kind: "forbidden" });
});

test("invalid or denied calls never open a transaction", async () => {
  const db = memoryDatabase();
  let opened = 0;
  const counting = { ...db, transaction: <T>(fn: (tx: Store) => Promise<T>) => { opened++; return db.transaction(fn); } };
  const r = createRegistry<Scope>({ modules: { items, log }, database: { adapter: counting }, services: { log: [] } });
  await expect(r.as({ actor: null, locale: "es" }).run(add, { name: "x" })).rejects.toMatchObject({ kind: "forbidden" });
  // @ts-expect-error invalid on purpose
  await expect(r.as({ actor: "a", locale: "es" }).run(add, { name: 1 })).rejects.toMatchObject({ kind: "invalid" });
  expect(opened).toEqual(0);
});
