import { sql, type SQL } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { DatabaseAdapter, Job, ReadWrite, SqlDatabase } from "../index.ts";

export { databaseQueue, jobsSchema, outbox, type DatabaseQueueOptions, type OutboxOptions, type StoredJobs } from "../postgres.ts";

/** Anything with Drizzle's `transaction(fn)` and `execute(sql)`: a database or a transaction (nested = savepoint). */
interface Transactional {
  transaction<T>(fn: (tx: any) => Promise<T>, config?: any): Promise<T>;
  execute(query: SQL, mode: "objects"): PromiseLike<Record<string, unknown>[]>;
}

/** The transaction type of a Drizzle database: `type Tx = DrizzleTx<typeof db>`. */
export type DrizzleTx<Db extends Transactional> = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What queries get: the database minus write methods. A type-level guard, not a runtime one. */
export type DrizzleReader<Db> = Omit<
  Db,
  "insert" | "update" | "delete" | "execute" | "transaction" | "batch" | "run" | "refreshMaterializedView"
>;

/**
 * Your database in `Config`: `db: DrizzleDb<Db>`, where `type Db = typeof db`. Queries get a `DrizzleReader`, mutations
 * the transaction.
 */
export type DrizzleDb<Db extends Transactional> = ReadWrite<DrizzleReader<DrizzleTx<Db>>, DrizzleTx<Db>>;

export type DrizzleAdapterOptions = Pick<DatabaseAdapter, "transactionAttempts">;

/**
 * Use a Drizzle database for mutations. Needs a driver with async interactive transactions: node-postgres, postgres.js,
 * PGlite, Neon websocket, Hyperdrive. Not D1 or HTTP drivers. SQLite has its own adapter, `logic-sdk/drizzle/sqlite`:
 * Drizzle's synchronous drivers commit before an async mutation finishes, and its types reject them here, like libsql,
 * where overlapping mutations fail.
 */
export function drizzleAdapter<Db extends Transactional>(
  db: Db,
  options: DrizzleAdapterOptions = {},
): SqlDatabase<Db, DrizzleTx<Db>> {
  return {
    db,
    transactions: "interactive",
    transactionAttempts: options.transactionAttempts,
    transaction: (fn) => db.transaction(fn),
    nest: (tx) => drizzleAdapter(tx),
    retryable: (e) => RETRYABLE.has(sqlState(e) ?? ""),
    query: async (client: Transactional, text, params) => client.execute(toSql(text, params), "objects"),
  };
}

/** SQL text with `$1` parameters as a Drizzle query. Splitting on a captured number leaves them at the odd places. */
const toSql = (text: string, params: unknown[]) =>
  sql.join(text.split(/\$(\d+)/).map((part, i) => (i % 2 ? sql.param(params[Number(part) - 1]) : sql.raw(part))));

/** Postgres: serialization_failure, deadlock_detected. The transaction lost a race; running it again is the fix. */
const RETRYABLE = new Set(["40001", "40P01"]);

/** The SQLSTATE of a driver error, also when Drizzle wraps it (`DrizzleQueryError.cause`). Use it to map constraints. */
export function sqlState(error: unknown): string | undefined {
  for (let e: any = error, i = 0; e && i < 5; e = e.cause, i++) if (typeof e.code === "string") return e.code;
  return undefined;
}

/** Rows not claimed yet: what `replace` may still replace. */
const waiting = sql`status = 'pending' and attempts = 0`;

/**
 * The table behind `databaseQueue` and `outbox` (Postgres), Laravel's `jobs`. Re-export it from your schema so
 * drizzle-kit adds it to your migrations: `export { jobsTable } from "logic-sdk/drizzle/pg";`. One row per pending job;
 * done rows are deleted, failed ones stay so you can query them and `retry` them.
 */
export const jobsTable = pgTable(
  "logic_jobs",
  {
    /** The job id: `<listener id>@<event id>`, `<cron id>@<minute>`, or `<function id>@<uuid>`. */
    id: text("id").primaryKey(),
    job: jsonb("job").$type<Job>().notNull(),
    /** `failed`: out of attempts, or a rule said no. Retrying is your call (`registry.jobs.retry(id)`). */
    status: text("status").$type<"pending" | "failed">().notNull().default("pending"),
    /** Incremented when a runner claims it, so a crash still uses an attempt. */
    attempts: integer("attempts").notNull().default(0),
    /** Due from then on. While claimed: when the lease ends and a sweep may take it over. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    /** The claim that owns it: a new one each time it's claimed, like SQS's receipt handle. Only it can finish the job. */
    receipt: text("receipt"),
    /** The last failure, with its stack. */
    lastError: text("last_error"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** A scheduled call's `replace` key, `<function id>@<key>`: a newer call with it replaces this row while it waits. */
    replaceKey: text("replace_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("logic_jobs_due").on(t.availableAt).where(sql`${t.status} = 'pending'`),
    // one waiting call per key: a claimed row (attempts > 0) has started, so a newer one doesn't touch it
    uniqueIndex("logic_jobs_replace").on(t.replaceKey).where(waiting),
  ],
);

/**
 * The cron runs already ticked, so a minute ticked twice (several servers, a redelivered trigger) runs once, like
 * Solid Queue's recurring executions. Re-export it next to `jobsTable` when you have crons. Rows older than a day go.
 */
export const cronRunsTable = pgTable("logic_cron_runs", {
  /** The cron job's id, `<cron id>@<minute>`. */
  id: text("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});
