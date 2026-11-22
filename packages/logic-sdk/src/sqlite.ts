// The jobs table on SQLite (3.42 or later, for `unixepoch('subsec')`), in SQL. With Drizzle, import from `logic-sdk/drizzle/sqlite` instead: the
// same two functions, plus the table for your schema. Times are whole milliseconds since 1970, on SQLite's clock.
// Every statement returns rows: better-sqlite3's `all()` refuses one that doesn't, so one `query` fits every driver.
import { storedJobs, type DatabaseQueueOptions, type JobsSql, type OutboxOptions, type StoredJobs } from "./stored-jobs.ts";
import type { Dispatcher, SqlDatabase } from "./index.ts";

export type { DatabaseQueueOptions, OutboxOptions, StoredJobs } from "./stored-jobs.ts";

const now = `cast(unixepoch('subsec') * 1000 as integer)`;

/** The tables behind `databaseQueue` and `outbox`, for your migrations. Drizzle users re-export `jobsTable` instead. */
export const jobsSchema = `
CREATE TABLE logic_jobs (
  id text PRIMARY KEY NOT NULL,
  job text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at integer NOT NULL DEFAULT (${now}),
  receipt text,
  last_error text,
  failed_at integer,
  replace_key text,
  created_at integer NOT NULL DEFAULT (${now})
);
CREATE INDEX logic_jobs_due ON logic_jobs (available_at) WHERE status = 'pending';
CREATE UNIQUE INDEX logic_jobs_replace ON logic_jobs (replace_key) WHERE status = 'pending' and attempts = 0;
CREATE TABLE logic_cron_runs (
  id text PRIMARY KEY NOT NULL,
  ran_at integer NOT NULL DEFAULT (${now})
);
`;

const ids = "(SELECT value FROM json_each(?))";
const mine = `id IN ${ids} AND receipt = ? AND status = 'pending'`;
const inSeconds = `${now} + cast(? * 1000 as integer)`;

const statements: JobsSql = {
  // the waiting call with this key becomes the new one: its id, job and time (Oban's `replace`). `json_each.key` is
  // the row's place in the list. `WHERE true`: SQLite needs it to tell an upsert's ON CONFLICT from a join's ON
  insert: `
    INSERT INTO logic_jobs (id, job, available_at, replace_key)
    SELECT value ->> 'id', value -> 'job', coalesce(value ->> 'at', ${inSeconds}), value ->> 'key'
    FROM json_each(?) WHERE true ORDER BY json_each.key
    ON CONFLICT (replace_key) WHERE status = 'pending' and attempts = 0
    DO UPDATE SET id = excluded.id, job = excluded.job, available_at = excluded.available_at, last_error = NULL
    RETURNING id`,
  recordTicks: `INSERT INTO logic_cron_runs (id) SELECT value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING RETURNING id`,
  pruneTicks: `DELETE FROM logic_cron_runs WHERE ran_at < ${now} - 86400000 RETURNING id`,
  claimNew: `
    UPDATE logic_jobs SET attempts = 1, receipt = ?, available_at = ${inSeconds}
    WHERE id IN ${ids} AND attempts = 0 AND status = 'pending' RETURNING id`,
  // no row locks to skip: SQLite has one writer at a time, and this statement is one write
  claimDue: `
    UPDATE logic_jobs SET attempts = attempts + 1, receipt = ?, available_at = ${inSeconds}
    WHERE id = (SELECT id FROM logic_jobs WHERE status = 'pending' AND available_at <= ${now} ORDER BY available_at LIMIT 1)
    RETURNING job, attempts`,
  extend: `UPDATE logic_jobs SET available_at = ${inSeconds} WHERE ${mine} RETURNING id`,
  backOff: `UPDATE logic_jobs SET available_at = ${inSeconds}, last_error = ? WHERE ${mine} RETURNING id`,
  markFailed: `UPDATE logic_jobs SET status = 'failed', last_error = ?, failed_at = ${now} WHERE ${mine} RETURNING id`,
  remove: `DELETE FROM logic_jobs WHERE ${mine} RETURNING id`,
  retry: `
    UPDATE logic_jobs SET status = 'pending', attempts = 0, receipt = NULL, available_at = ${now}, last_error = NULL, failed_at = NULL, replace_key = NULL
    WHERE id = ? AND status = 'failed' RETURNING id`,
  fail: `
    INSERT INTO logic_jobs (id, job, status, last_error, failed_at) VALUES (?, ?, 'failed', ?, ${now})
    ON CONFLICT (id) DO UPDATE SET status = 'failed', last_error = excluded.last_error, failed_at = excluded.failed_at
    RETURNING id`,
};

/** Your database as the queue: see `databaseQueue` in `logic-sdk/postgres`, which this matches. */
export const databaseQueue = (database: SqlDatabase, options: DatabaseQueueOptions = {}): StoredJobs => storedJobs(statements, database, options);

/** A table in front of another queue: see `outbox` in `logic-sdk/postgres`, which this matches. */
export const outbox = (database: SqlDatabase, queue: Dispatcher, options: OutboxOptions = {}): StoredJobs => storedJobs(statements, database, options, queue);
