import { sql, type SQL } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { DatabaseAdapter, Job, ReadWrite, SqlDatabase } from "../index.ts";

export { databaseQueue, jobsSchema, outbox, type DatabaseQueueOptions, type OutboxOptions, type StoredJobs } from "../sqlite.ts";

/** A Drizzle database on a synchronous SQLite driver: node:sqlite, bun:sqlite, better-sqlite3. */
interface SyncSqlite {
  all<T>(query: SQL): T[];
  run(query: SQL): unknown;
  $client: { close(): unknown };
}

/** What mutations get: a connection of their own, inside the transaction the adapter opened. */
export type DrizzleTx<Db> = Omit<Db, "transaction" | "$client">;

/** What queries get: the reading connection, minus write methods. SQLite refuses a write on it too (`query_only`). */
export type DrizzleReader<Db> = Omit<Db, "insert" | "update" | "delete" | "run" | "transaction" | "batch" | "$client">;

/** Your database in `Config`: `db: DrizzleDb<ReturnType<typeof open>>`, where `open` is what `drizzleAdapter` gets. */
export type DrizzleDb<Db> = ReadWrite<DrizzleReader<Db>, DrizzleTx<Db>>;

export type DrizzleAdapterOptions = Pick<DatabaseAdapter, "transactionAttempts">;

/** Milliseconds to wait for another writer before failing. Rails' default `timeout`. */
const BUSY_TIMEOUT = 5000;

/**
 * Use SQLite on a disk for mutations, through Drizzle on a synchronous driver, set up like Rails: WAL, and
 * `BEGIN IMMEDIATE`. `open` opens a connection: one stays to read, and each transaction gets its own, closed when it
 * ends, so a write that arrives late is refused instead of landing outside it. Call this once per process.
 *
 * ```ts
 * const database = drizzleAdapter(() => drizzle("app.db"));
 * ```
 */
export function drizzleAdapter<Db extends SyncSqlite>(
  open: () => Db,
  options: DrizzleAdapterOptions = {},
): SqlDatabase<DrizzleReader<Db>, DrizzleTx<Db>> {
  const reader = open();
  checkOpen(open, reader);
  exec(reader, `PRAGMA busy_timeout = ${BUSY_TIMEOUT}`); // in WAL a read only waits while a crash is being recovered
  exec(reader, "PRAGMA query_only = ON");

  const takeTurn = turns();
  const transaction = <T>(fn: (tx: DrizzleTx<Db>) => Promise<T>) =>
    takeTurn(async (restartClock) => {
      const tx = await begin(open, restartClock);
      try {
        const out = await fn(tx);
        exec(tx, "COMMIT");
        return out;
      } catch (e) {
        undo(tx, "ROLLBACK");
        throw e;
      } finally {
        tx.$client.close();
      }
    });

  return {
    db: reader,
    transactions: "interactive",
    transactionAttempts: options.transactionAttempts,
    transaction,
    nest: (tx) => savepoints(tx),
    retryable: isBusy,
    // on a transaction, inside it. On the database, a transaction of its own that waits its turn, like any write
    query: async (client: Pick<SyncSqlite, "all">, text, params) =>
      client === reader ? transaction(async (tx) => rowsOf(tx, text, params)) : rowsOf(client, text, params),
  };
}

/** Transactions inside a transaction, as savepoints: the test registry's. */
function savepoints<Tx extends Pick<SyncSqlite, "all" | "run">>(tx: Tx): SqlDatabase<Tx, Tx> {
  const takeTurn = turns();
  return {
    db: tx,
    transactions: "interactive",
    transaction: (fn) =>
      takeTurn(async () => {
        exec(tx, "SAVEPOINT logic_sdk");
        try {
          const out = await fn(tx);
          exec(tx, "RELEASE logic_sdk");
          return out;
        } catch (e) {
          undo(tx, "ROLLBACK TO logic_sdk", "RELEASE logic_sdk"); // rolling back to a savepoint keeps it
          throw e;
        }
      }),
    nest: savepoints,
    query: async (client, text, params) => rowsOf(client, text, params),
  };
}

const exec = (db: Pick<SyncSqlite, "run">, text: string) => db.run(sql.raw(text));

/** SQL text with `?` parameters as a Drizzle query. */
const toSql = (text: string, params: unknown[]) =>
  sql.join(text.split("?").flatMap((part, i) => (i ? [sql.param(params[i - 1]), sql.raw(part)] : [sql.raw(part)])));

const rowsOf = (db: Pick<SyncSqlite, "all">, text: string, params: unknown[]) =>
  db.all<Record<string, unknown>>(toSql(text, params));

/** SQLite rolls some failures back by itself (a full disk, `RAISE(ROLLBACK)`): then there's nothing to undo, and the error that did it is the one to report. */
function undo(db: Pick<SyncSqlite, "run">, ...statements: string[]) {
  try {
    for (const statement of statements) exec(db, statement);
  } catch {}
}

/** Refused at startup: either mistake would otherwise show up later, as missing writes or a closed connection. */
function checkOpen<Db extends SyncSqlite>(open: () => Db, reader: Db) {
  const another = open();
  if (another.$client === reader.$client)
    throw new Error('[logic-sdk] drizzleAdapter needs a function that opens a new connection each time: drizzleAdapter(() => drizzle("app.db")).');
  const [main] = another.all<{ file: string }>(sql`PRAGMA database_list`);
  another.$client.close();
  if (!main?.file)
    throw new Error("[logic-sdk] drizzleAdapter needs SQLite on a disk: an in-memory database is a different one on each connection. Use a temporary file in tests.");
}

/**
 * A new connection that holds the write lock. Another process may have it: we wait here, with the event loop free,
 * since waiting inside SQLite stops the whole process on a synchronous driver (Rails' busy handler, for the same reason).
 */
async function begin<Db extends SyncSqlite>(open: () => Db, restartClock: () => void): Promise<Db> {
  const deadline = Date.now() + BUSY_TIMEOUT;
  for (;;) {
    restartClock(); // those behind us in line time how long we hold the lock, not how long another process does
    let tx: Db | undefined;
    try {
      tx = open();
      exec(tx, "PRAGMA busy_timeout = 0");
      exec(tx, "PRAGMA journal_mode = WAL"); // here, not at startup: processes starting together would find it locked
      exec(tx, "BEGIN IMMEDIATE");
      return tx;
    } catch (e) {
      tx?.$client.close();
      if (!isBusy(e) || Date.now() >= deadline) throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 1 + Math.random() * 4));
  }
}

/**
 * One at a time, in order, since SQLite has one writer. Waiting in a line that moves is fine, however long. It fails
 * when the transaction ahead has held the lock for 5 seconds: often one that waits for a call behind it, forever.
 */
function turns() {
  let last = Promise.resolve();
  let startedAt = 0;
  const restartClock = () => {
    startedAt = Date.now();
  };
  return async <T>(work: (restartClock: () => void) => Promise<T>): Promise<T> => {
    const arrived = Date.now();
    const ahead = last;
    const done = Promise.withResolvers<void>();
    last = ahead.then(() => done.promise);
    try {
      const giveUpAt = () => Math.max(arrived, startedAt) + BUSY_TIMEOUT;
      while (!(await settlesBy(ahead, giveUpAt()))) {
        // the one ahead may have changed while we waited: the line moved
        if (Date.now() >= giveUpAt()) throw new Error(HELD);
      }
      restartClock();
      return await work(restartClock);
    } finally {
      done.resolve();
    }
  };
}

const HELD =
  "[logic-sdk] Waited 5 seconds for a transaction in this process, and SQLite writes one at a time. Does a mutation await registry.as(scope).run instead of ctx.run, or do slow work that belongs in an action? In tests, is a t.begin() still open?";

/** Whether `promise` settles by then. The timer is cleared, so a process with nothing else to do can exit. */
const settlesBy = (promise: Promise<void>, time: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), time - Date.now());
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/** SQLITE_BUSY, also when Drizzle wraps it: someone else is writing. Laravel matches the same message. */
function isBusy(error: unknown): boolean {
  for (let e: any = error, i = 0; e && i < 5; e = e.cause, i++)
    if (e.code === "SQLITE_BUSY" || /database is locked/.test(e.message)) return true;
  return false;
}

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/**
 * The table behind `databaseQueue` and `outbox` (SQLite), Laravel's `jobs`. Re-export it from your schema so
 * drizzle-kit adds it to your migrations: `export { jobsTable } from "logic-sdk/drizzle/sqlite";`. One row per pending
 * job; done rows are deleted, failed ones stay so you can query them and `retry` them.
 */
export const jobsTable = sqliteTable(
  "logic_jobs",
  {
    /** The job id: `<listener id>@<event id>`, `<cron id>@<minute>`, or `<function id>@<uuid>`. */
    id: text("id").primaryKey(),
    job: text("job", { mode: "json" }).$type<Job>().notNull(),
    /** `failed`: out of attempts, or a rule said no. Retrying is your call (`registry.jobs.retry(id)`). */
    status: text("status").$type<"pending" | "failed">().notNull().default("pending"),
    /** Incremented when a runner claims it, so a crash still uses an attempt. */
    attempts: integer("attempts").notNull().default(0),
    /** Due from then on. While claimed: when the lease ends and a sweep may take it over. */
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull().default(now),
    /** The claim that owns it: a new one each time it's claimed, like SQS's receipt handle. Only it can finish the job. */
    receipt: text("receipt"),
    /** The last failure, with its stack. */
    lastError: text("last_error"),
    failedAt: integer("failed_at", { mode: "timestamp_ms" }),
    /** A scheduled call's `replace` key, `<function id>@<key>`: a newer call with it replaces this row while it waits. */
    replaceKey: text("replace_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    index("logic_jobs_due").on(t.availableAt).where(sql`${t.status} = 'pending'`),
    // one waiting call per key: a claimed row (attempts > 0) has started, so a newer one doesn't touch it
    uniqueIndex("logic_jobs_replace").on(t.replaceKey).where(sql`status = 'pending' and attempts = 0`),
  ],
);

/** The cron runs already ticked, so a minute ticked twice runs once. Re-export it next to `jobsTable` when you have crons. */
export const cronRunsTable = sqliteTable("logic_cron_runs", {
  /** The cron job's id, `<cron id>@<minute>`. */
  id: text("id").primaryKey(),
  ranAt: integer("ran_at", { mode: "timestamp_ms" }).notNull().default(now),
});
