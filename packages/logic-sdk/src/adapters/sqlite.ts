// The jobs table on SQLite (3.42 or later, for `unixepoch('subsec')`), in SQL. With Drizzle, import from
// `logic-sdk/drizzle/sqlite` instead: the same two functions, plus the table for your schema. Times are whole milliseconds since 1970, on SQLite's clock.
// Every statement returns rows: better-sqlite3's `all()` refuses one that doesn't, so one `query` fits every driver.
import { failedStore, storedJobs, type DatabaseQueueOptions, type JobsSql, type OutboxOptions, type StoredJobs } from "./stored-jobs.ts";
import type { FailedJobs, JobsAdapter } from "../core/types.ts";

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
  claimed_at integer,
  last_error text,
  failed_at integer,
  unique_key text,
  order_key text,
  created_at integer NOT NULL DEFAULT (${now})
);
CREATE INDEX logic_jobs_due ON logic_jobs (available_at) WHERE status = 'pending';
CREATE UNIQUE INDEX logic_jobs_unique ON logic_jobs (unique_key) WHERE status = 'pending' and attempts = 0;
CREATE INDEX logic_jobs_order ON logic_jobs (order_key) WHERE status = 'pending';
CREATE INDEX logic_jobs_failed ON logic_jobs (failed_at, id) WHERE status = 'failed';
CREATE TABLE logic_cron_runs (
  id text PRIMARY KEY NOT NULL,
  ran_at integer NOT NULL DEFAULT (${now})
);
CREATE INDEX logic_cron_runs_ran_at ON logic_cron_runs (ran_at);
`;

const mine = `id = ? AND receipt = ? AND status = 'pending'`;
const inSeconds = `${now} + cast(? * 1000 as integer)`;
/**
 * A row may run when it has started already (one per key: a retry backing off), or when no other open row of its key
 * started or came before it (`rowid`, the insert order). A failed row put back by `retry(id)` waits behind one that started.
 */
const firstOfKey = `(order_key IS NULL OR attempts > 0 OR NOT EXISTS (
  SELECT 1 FROM logic_jobs o WHERE o.order_key = logic_jobs.order_key AND o.status = 'pending' AND o.id <> logic_jobs.id AND (o.rowid < logic_jobs.rowid OR o.attempts > 0)))`;

const statements: JobsSql = {
  // a waiting row with this key: a call replaces it (its id, job and time: Oban's `replace`), a unique delivery is
  // dropped. `json_each.key` is the row's place in the list. `WHERE true`: SQLite needs it to tell an upsert's ON
  // CONFLICT from a join's ON
  insert: `
    INSERT INTO logic_jobs (id, job, available_at, unique_key, order_key)
    SELECT value ->> 'id', value -> 'job', coalesce(value ->> 'at', ${inSeconds}), value ->> 'unique', value ->> 'order'
    FROM json_each(?) WHERE true ORDER BY json_each.key
    ON CONFLICT (unique_key) WHERE status = 'pending' and attempts = 0
    DO UPDATE SET id = excluded.id, job = excluded.job, available_at = excluded.available_at, last_error = NULL
    WHERE excluded.job ->> 'kind' = 'call'
    RETURNING id`,
  recordTicks: `INSERT INTO logic_cron_runs (id) SELECT value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING RETURNING id`,
  pruneTicks: `DELETE FROM logic_cron_runs WHERE ran_at < ${now} - 86400000 RETURNING id`,
  claimNew: `
    UPDATE logic_jobs SET attempts = 1, receipt = ?, claimed_at = ${now}, available_at = ${inSeconds}
    WHERE id = ? AND attempts = 0 AND status = 'pending' AND ${firstOfKey} RETURNING id`,
  // no row locks to skip: SQLite has one writer at a time, and this statement is one write
  claimDue: `
    UPDATE logic_jobs SET attempts = attempts + 1, receipt = ?, claimed_at = ${now}, available_at = ${inSeconds}
    WHERE id = (SELECT id FROM logic_jobs WHERE status = 'pending' AND available_at <= ${now} - cast(? * 1000 as integer) AND ${firstOfKey}
      AND coalesce(nullif(?, ''), coalesce(job ->> 'queue', 'default')) = coalesce(job ->> 'queue', 'default') ORDER BY available_at LIMIT 1)
    RETURNING job, attempts`,
  claimOne: `
    UPDATE logic_jobs SET attempts = attempts + 1, receipt = ?, claimed_at = ${now}, available_at = ${inSeconds}
    WHERE id = ? AND status = 'pending' AND available_at <= ${now}
    RETURNING job, attempts`,
  // due, or never tried and waiting only for its turn (not for a `delay`): no need to wait for a sweep
  claimNext: `
    UPDATE logic_jobs SET attempts = attempts + 1, receipt = ?, claimed_at = ${now}, available_at = ${inSeconds}
    WHERE id = (SELECT id FROM logic_jobs WHERE status = 'pending' AND order_key = ? AND (available_at <= ${now} OR (attempts = 0 AND job ->> 'runAt' IS NULL))
      AND ${firstOfKey} ORDER BY rowid LIMIT 1)
    RETURNING job, attempts`,
  extend: `UPDATE logic_jobs SET available_at = ${inSeconds} WHERE ${mine} RETURNING id`,
  backOff: `UPDATE logic_jobs SET available_at = ${inSeconds}, last_error = ?, claimed_at = NULL WHERE ${mine} RETURNING id`,
  markFailed: `UPDATE logic_jobs SET status = 'failed', last_error = ?, failed_at = ${now}, claimed_at = NULL WHERE ${mine} RETURNING id`,
  remove: `DELETE FROM logic_jobs WHERE ${mine} RETURNING id`,
  retry: `
    UPDATE logic_jobs SET status = 'pending', attempts = 0, receipt = NULL, claimed_at = NULL, available_at = ${now}, last_error = NULL, failed_at = NULL, unique_key = NULL
    WHERE id = ? AND status = 'failed' RETURNING id`,
  fail: `
    INSERT INTO logic_jobs (id, job, status, last_error, failed_at) VALUES (?, ?, 'failed', ?, ${now})
    ON CONFLICT (id) DO UPDATE SET status = 'failed', last_error = excluded.last_error, failed_at = excluded.failed_at
    RETURNING id`,
  // each field by its type and value: a missing one isn't null, and true isn't 1
  failed: `
    WITH p(source, want, at, after_id) AS (SELECT NULLIF(?, ''), NULLIF(?, ''), CAST(NULLIF(?, '') AS INTEGER), NULLIF(?, ''))
    SELECT j.id, j.job, j.last_error, j.failed_at FROM logic_jobs j, p
    WHERE j.status = 'failed'
      AND (p.source IS NULL OR coalesce(j.job ->> '$.listener', j.job ->> '$.cron', j.job ->> '$.fn') = p.source)
      AND (p.want IS NULL OR NOT EXISTS (
        SELECT 1 FROM json_each(p.want) AS w
        WHERE json_type(coalesce(j.job -> '$.scope', j.job -> '$.envelope.scope'), w.value ->> '$.jsonPath') IS NOT json_type(w.value, '$.value')
           OR json_extract(coalesce(j.job -> '$.scope', j.job -> '$.envelope.scope'), w.value ->> '$.jsonPath') IS NOT json_extract(w.value, '$.value')))
      AND (p.at IS NULL OR (j.failed_at, j.id) < (p.at, p.after_id))
    ORDER BY j.failed_at DESC, j.id DESC
    LIMIT ?`,
  forget: `DELETE FROM logic_jobs WHERE id = ? AND status = 'failed' RETURNING id`,
  take: `DELETE FROM logic_jobs WHERE id = ? AND status = 'failed' RETURNING job`,
};

/** Your database as the queue: see `databaseQueue` in `logic-sdk/postgres`, which this matches. */
export const databaseQueue = (options: DatabaseQueueOptions = {}): StoredJobs => storedJobs(statements, options);

/** A table in front of another queue: see `outbox` in `logic-sdk/postgres`, which this matches. */
export const outbox = (queue: JobsAdapter, options: OutboxOptions = {}): StoredJobs => storedJobs(statements, options, queue);

/**
 * Failed jobs in your jobs table, for a queue that can't keep them itself: `jobs: { adapter: cloudflareQueue(env.JOBS),
 * failed: failedJobs() }`. Like Laravel's `failed` driver. `databaseQueue` and `outbox` keep their own.
 */
export const failedJobs = (): FailedJobs => failedStore(statements);
