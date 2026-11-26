import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, test } from "bun:test";
import { z } from "zod";
import { drizzleAdapter, sqlState, type DrizzleDb } from "../../src/drizzle/pg.ts";
import { init } from "../../src/index.ts";

// PGlite runs one transaction at a time, so only real Postgres can deadlock (CI sets DATABASE_URL).
const url = process.env.DATABASE_URL ?? "";

test.skipIf(!url)("two mutations deadlock: the default runs the loser again, one try fails it", async () => {
  const client = postgres(url, { max: 4, onnotice: () => {} });
  const db = drizzle({ client });
  await db.execute(sql`create schema if not exists logic_deadlock`);
  await db.execute(sql`create table if not exists logic_deadlock.rows (id text primary key)`);
  await db.execute(sql`insert into logic_deadlock.rows values ('a'), ('b') on conflict do nothing`);
  const { mutation, createRegistry } = init<{ scope: object; db: DrizzleDb<typeof db> }>();

  async function race(transactionAttempts?: number) {
    let holding = 0;
    const bothHold = Promise.withResolvers<void>();
    const lockBoth = mutation({
      input: z.object({ first: z.string(), next: z.string() }),
      async handler(ctx, { first, next }) {
        await ctx.db.execute(sql`select id from logic_deadlock.rows where id = ${first} for update`);
        if (++holding === 2) bothHold.resolve();
        await bothHold.promise; // each holds what the other wants next
        await ctx.db.execute(sql`select id from logic_deadlock.rows where id = ${next} for update`);
      },
    });
    const app = createRegistry({ modules: { x: { lockBoth } }, database: { adapter: drizzleAdapter(db), transactionAttempts } }).as({});
    const outcomes = await Promise.allSettled([app.run(lockBoth, { first: "a", next: "b" }), app.run(lockBoth, { first: "b", next: "a" })]);
    return outcomes.map((o) => (o.status === "fulfilled" ? "committed" : sqlState(o.reason))).sort();
  }

  expect(await race()).toEqual(["committed", "committed"]);
  expect(await race(1)).toEqual(["40P01", "committed"]);
  await client.end();
}, 30_000);
