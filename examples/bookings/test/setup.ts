import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle as pglite } from "drizzle-orm/pglite";
import { drizzle as postgresJs } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createTestRegistry } from "logic-sdk/testing";
import { afterEach, beforeEach } from "vitest";
import { makeRegistry } from "../src/registry";
import type { Db } from "../src/logic";
import type { Role, Scope } from "../src/scope";
import { memoryMailer, memoryPayments } from "../src/services";

export const migration = readFileSync(new URL("../src/db/migrate.sql", import.meta.url), "utf8");

/**
 * The database for a test file. With DATABASE_URL (CI, `bun run test:pg`) it's real Postgres through the same
 * driver as production, already migrated by global-setup.ts. Without it, an in-process PGlite: the real Postgres
 * engine in WASM, no Docker needed, but one connection at a time (so it can't race).
 * Either way, each test is a rolled-back transaction.
 */
export async function setup() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const db = postgresJs({ client: postgres(url, { onnotice: () => {} }) }) as unknown as Db;
    return { db, registry: makeRegistry(db, { mailer: memoryMailer(), payments: memoryPayments() }) };
  }
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(migration);
  const db = pglite({ client: pg }) as unknown as Db;
  return { db, registry: makeRegistry(db, { mailer: memoryMailer(), payments: memoryPayments() }) };
}

export const scopeAs = (role: Role | null, accountId = "acc_1", locale = "es"): Scope => ({
  actor: role ? { id: `${role}_1`, role } : null,
  accountId,
  locale,
  requestId: "req_test",
});

/**
 * The test registry for a file: in-memory services, frozen time, and each test in a transaction that's rolled back.
 * Call it once at the top of a test file, like Phoenix's `use MyApp.DataCase`.
 */
export async function testRegistry(options: { jobs?: "inline" | "manual" } = {}) {
  const { registry } = await setup();
  const mailer = memoryMailer();
  const payments = memoryPayments();
  const t = createTestRegistry(registry, { services: { mailer, payments }, now: "2026-06-01T09:00:00Z", ...options });

  beforeEach(async () => {
    mailer.sent.length = 0;
    payments.charges.clear();
    await t.begin();
  });
  afterEach(() => t.rollback());

  return { t, mailer, payments };
}
