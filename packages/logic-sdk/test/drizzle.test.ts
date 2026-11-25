import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { expect, test } from "bun:test";
import { drizzleAdapter, type DrizzleDb } from "../src/drizzle/pg.ts";
import { init } from "../src/index.ts";
import { createTestRegistry } from "../src/testing.ts";

const db = drizzle({ client: new PGlite() });
const { mutation, createRegistry } = init<{ scope: object; db: DrizzleDb<typeof db> }>();

let tries = 0;
const deadlocks = mutation({
  async handler(ctx) {
    tries++;
    await ctx.db.execute(sql`do $$ begin raise exception 'lost the race' using errcode = '40P01'; end $$`);
  },
});

test("a deadlock gets three tries by default, or drizzleAdapter's transactionAttempts, in tests too", async () => {
  const modules = { x: { deadlocks } };
  const standard = createRegistry({ modules, database: drizzleAdapter(db) });
  const twice = createRegistry({ modules, database: drizzleAdapter(db, { transactionAttempts: 2 }) });

  tries = 0;
  await expect(standard.as({}).run(deadlocks)).rejects.toThrow();
  expect(tries).toBe(3);

  tries = 0;
  await expect(twice.as({}).run(deadlocks)).rejects.toThrow();
  expect(tries).toBe(2);

  const t = createTestRegistry(twice);
  await t.begin();
  tries = 0;
  await expect(t.as({}).run(deadlocks)).rejects.toThrow();
  expect(tries).toBe(2);
  await t.rollback();
});

test("a deadlock a caller caught and went on from is still retried: Postgres fails the next statement with 25P02", async () => {
  await db.execute(sql`create table if not exists after_catch (v text)`);
  let attempts = 0;
  const losesOnce = mutation({
    async handler(ctx) {
      if (++attempts === 1) await ctx.db.execute(sql`do $$ begin raise exception 'lost the race' using errcode = '40P01'; end $$`);
    },
  });
  const goesOn = mutation({
    async handler(ctx) {
      try { await ctx.run(losesOnce); } catch {}
      await ctx.db.execute(sql`insert into after_catch values ('written')`);
      return "ok";
    },
  });
  const app = createRegistry({ modules: { x: { losesOnce, goesOn } }, database: drizzleAdapter(db) }).as({});
  expect(await app.run(goesOn)).toBe("ok");
  expect(attempts).toBe(2);
  expect((await db.execute(sql`select v from after_catch`)).rows).toEqual([{ v: "written" }]);
});
