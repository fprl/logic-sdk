// Transactions: what a failure undoes, nested failures, and the database adapter's retries.
import { z } from "zod";
import { expect, test } from "bun:test";
import { createRegistry } from "../../src/index.ts";
import { add, items, log, mutation, reg, regSetup, setup, type Scope } from "../support/app.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

/** The error and what it wraps (`cause`), like the Postgres adapter's `retryable` reads it. */
function* causes(error: unknown): Generator<object> {
  for (let e = error; typeof e === "object" && e !== null; e = "cause" in e ? e.cause : undefined) yield e;
}

test("failed mutation: nothing written, no events", async () => {
  const { app, services, db } = setup();
  await expect(app.run(items.add, { name: "boom" })).rejects.toMatchObject({ code: "items.boom" });
  expect(db.store.rows.items).toEqual(undefined);
  expect(services.log).toEqual([]);
});

test("a nested failure dooms the transaction even when caught: the commit says which, and how to split it", async () => {
  const { app, services, db } = setup();
  const failure = await app.run(items.addTwo, { a: "ok", b: "boom" }).then(() => undefined, (e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(
    /^\[logic-sdk\] items\.add failed inside items\.addTwo's transaction \(items\.addTwo → items\.add\) and was caught, so items\.addTwo can't commit: .* run them from an action\. The failure \(this error's cause\): /,
  );
  expect((failure as Error).cause).toMatchObject({ code: "items.boom" });
  expect(db.store.rows.items).toEqual(undefined);
  expect(services.log).toEqual([]);
});

test("a caught nested failure of any kind dooms the transaction: `throw undefined`, invalid input", async () => {
  const { app, db } = regSetup();
  await expect(app.run(reg.swallowsUndefined, {})).rejects.toThrow();
  await expect(app.run(reg.swallowsBadInput, {})).rejects.toThrow(/run with invalid input/);
  expect(db.store.rows.t).toEqual(undefined);
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
  const r = createRegistry<Scope>({ modules: { items, log }, database: { adapter: retrying }, services });
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
  const r = createRegistry<Scope>({ modules: { items, log }, database: { adapter: racy }, services });
  expect(await r.as({ actor: "a", locale: "es" }).run(add, { name: "again" })).toEqual({ name: "again" });
  expect(attempts).toEqual(2);
  expect(db.store.rows.items).toEqual([{ name: "again" }]);
  expect(services.log).toEqual(["added again (items.added, es)"]);
});

test("a deadlock in a nested mutation the caller caught still re-runs the transaction: `retryable` finds it as the cause", async () => {
  const db = memoryDatabase();
  let attempts = 0;
  const flaky = mutation({
    input: z.object({}),
    async handler() {
      if (++attempts === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    },
  });
  const swallows = mutation({
    input: z.object({}),
    async handler({ db: tx, run }) {
      try { await run(flaky, {}); } catch {}
      (tx.rows.t ??= []).push("done");
      return "ok";
    },
  });
  // like the Postgres adapter's: the driver's code anywhere in the chain
  const retryable = (e: unknown) => [...causes(e)].some((c) => "code" in c && c.code === "40P01");
  const r = createRegistry<Scope>({ modules: { x: { flaky, swallows } }, database: { adapter: { ...db, retryable } } });
  expect(await r.as({ actor: "a", locale: "es" }).run(swallows, {})).toEqual("ok");
  expect(attempts).toEqual(2);
  expect(db.store.rows.t).toEqual(["done"]);
});

test("the commit's error names the path, so a catch in the middle shows: a → b → c", async () => {
  const fails = mutation({ input: z.object({}), async handler({ errors }) { throw errors.reject("no"); } });
  const catches = mutation({ input: z.object({}), async handler({ run }) { try { await run(fails, {}); } catch {} } });
  const outer = mutation({ input: z.object({}), async handler({ run }) { await run(catches, {}); } });
  const r = createRegistry<Scope>({ modules: { x: { fails, catches, outer } }, database: { adapter: memoryDatabase() } });
  await expect(r.as({ actor: "a", locale: "es" }).run(outer, {})).rejects.toThrow(
    "x.fails failed inside x.outer's transaction (x.outer → x.catches → x.fails) and was caught",
  );
});

test("retries stop after `transactionAttempts`, and errors that aren't retryable are never retried", async () => {
  let calls = 0;
  const db = memoryDatabase();
  const alwaysDeadlocks = { ...db, retryable: () => true,
    transaction: async () => { calls++; throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); } };
  const r = createRegistry<Scope>({ modules: { items, log }, database: { adapter: alwaysDeadlocks, transactionAttempts: 2 }, services: { log: [] } });
  await expect(r.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(2);

  calls = 0;
  const r2 = createRegistry<Scope>({ modules: { items, log }, database: { adapter: { ...alwaysDeadlocks, retryable: () => false } }, services: { log: [] } });
  await expect(r2.as({ actor: "a", locale: "es" }).run(add, { name: "x" })).rejects.toThrow(/deadlock/);
  expect(calls).toEqual(1);

  expect(() => createRegistry<Scope>({ modules: {}, database: { adapter: db, transactionAttempts: 0 } })).toThrow(
    /database transaction attempts must be a whole number of tries, 1 or more \(got 0\)/,
  );
});
