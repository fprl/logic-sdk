import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, test } from "bun:test";
import postgres from "postgres";
import { cronRunsTable, drizzleAdapter, jobsTable } from "../src/drizzle/pg.ts";
import type { SqlDatabase } from "../src/index.ts";
import { databaseQueue, jobsSchema, outbox } from "../src/postgres.ts";
import { seamScenarios } from "./seam-scenarios.ts";

const postgresTarget = { databaseQueue, outbox, param: "$1", past: "now() - interval '1 second'" };
const tables = `${jobsSchema} CREATE TABLE seam_items (name text NOT NULL);`;

async function openPglite() {
  const client = new PGlite();
  await client.exec(tables);
  return client;
}
/** Temporary tables on one connection, so whatever database DATABASE_URL names keeps its own. */
async function openPostgres(url: string) {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  await client.unsafe(tables.replaceAll("CREATE TABLE", "CREATE TEMP TABLE"));
  return client;
}

// no ORM: an adapter is what another ORM's user would write
seamScenarios("jobs table: PGlite, no ORM", {
  ...postgresTarget,
  async open() {
    const client = await openPglite();
    const database: SqlDatabase = {
      db: client,
      transaction: (fn) => client.transaction(fn),
      query: async (on, text, params) => (await on.query(text, params)).rows,
    };
    return { database, close: () => client.close() };
  },
});

seamScenarios("jobs table: Drizzle on PGlite", {
  ...postgresTarget,
  async open() {
    const client = await openPglite();
    return { database: drizzleAdapter(drizzlePglite({ client })), close: () => client.close() };
  },
});

// PGlite takes parameters a wire-protocol driver encodes differently (JSON, numbers): CI runs these on real Postgres
const url = process.env.DATABASE_URL;
if (url) {
  seamScenarios("jobs table: postgres.js, no ORM", {
    ...postgresTarget,
    async open() {
      const client = await openPostgres(url);
      const database: SqlDatabase = {
        db: client,
        transaction: (fn) => client.begin(fn) as Promise<any>, // postgres.js types it for returning an array of queries
        query: (on, text, params) => on.unsafe(text, params),
      };
      return { database, close: () => client.end() };
    },
  });

  seamScenarios("jobs table: Drizzle on postgres.js", {
    ...postgresTarget,
    async open() {
      const client = await openPostgres(url);
      return { database: drizzleAdapter(drizzlePostgres({ client })), close: () => client.end() };
    },
  });
}

test("jobsSchema is the table Drizzle users re-export", async () => {
  const client = await openPglite();
  for (const table of [jobsTable, cronRunsTable]) {
    const { name, columns, indexes } = getTableConfig(table);
    const real = await client.query<{ name: string; type: string; required: boolean; defaulted: boolean }>(
      `select attname as name, format_type(atttypid, atttypmod) as type, attnotnull as required, atthasdef as defaulted
       from pg_attribute where attrelid = $1::regclass and attnum > 0 order by attnum`,
      [name],
    );
    expect(real.rows).toEqual(
      columns.map((c) => ({ name: c.name, type: c.getSQLType(), required: c.notNull, defaulted: c.hasDefault })),
    );
    const made = await client.query<{ name: string; unique: boolean }>(
      `select c.relname as name, i.indisunique as unique from pg_index i join pg_class c on c.oid = i.indexrelid
       where i.indrelid = $1::regclass and not i.indisprimary order by 1`,
      [name],
    );
    expect(made.rows).toEqual(indexes.map((i) => ({ name: i.config.name!, unique: i.config.unique })).sort((a, b) => (a.name < b.name ? -1 : 1)));
  }
  await client.close();
});
