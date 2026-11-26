// The jobs table on Postgres, in SQL. With Drizzle, import from `logic-sdk/drizzle/pg` instead: the same two
// functions, plus the table for your schema.
import { failedStore, storedJobs, type DatabaseQueueOptions, type JobsSql, type OutboxOptions, type StoredJobs } from "./stored-jobs.ts";
import type { FailedJobs, JobsAdapter } from "../core/types.ts";

/** The tables behind `databaseQueue` and `outbox`, for your migrations. Drizzle users re-export `jobsTable` instead. */
export const jobsSchema = `
CREATE TABLE logic_jobs (
  id text PRIMARY KEY,
  job jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  receipt text,
  claimed_at timestamptz,
  last_error text,
  failed_at timestamptz,
  replace_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX logic_jobs_due ON logic_jobs (available_at) WHERE status = 'pending';
CREATE UNIQUE INDEX logic_jobs_replace ON logic_jobs (replace_key) WHERE status = 'pending' and attempts = 0;
CREATE INDEX logic_jobs_failed ON logic_jobs (failed_at, id) WHERE status = 'failed';
CREATE TABLE logic_cron_runs (
  id text PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX logic_cron_runs_ran_at ON logic_cron_runs (ran_at);
`;

// `$n::text::jsonb`, not `$n::jsonb`: a driver that sees a jsonb parameter encodes our JSON string a second time.
const ids = (n: number) => `(SELECT jsonb_array_elements_text($${n}::text::jsonb))`;
const mine = (n: number) => `id IN ${ids(n)} AND receipt = $${n + 1} AND status = 'pending'`;
const inSeconds = (n: number) => `now() + make_interval(secs => $${n}::float8)`;

const statements: JobsSql = {
  // the waiting call with this key becomes the new one: its id, job and time (Oban's `replace`)
  insert: `
    INSERT INTO logic_jobs (id, job, available_at, replace_key)
    SELECT r->>'id', r->'job', coalesce(to_timestamp((r->>'at')::float8 / 1000), ${inSeconds(1)}), r->>'key'
    FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY AS rows(r, n) ORDER BY n
    ON CONFLICT (replace_key) WHERE status = 'pending' and attempts = 0
    DO UPDATE SET id = excluded.id, job = excluded.job, available_at = excluded.available_at, last_error = NULL`,
  recordTicks: `INSERT INTO logic_cron_runs (id) SELECT jsonb_array_elements_text($1::text::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
  pruneTicks: `DELETE FROM logic_cron_runs WHERE ran_at < now() - interval '1 day'`,
  claimNew: `
    UPDATE logic_jobs SET attempts = 1, receipt = $1, claimed_at = now(), available_at = ${inSeconds(2)}
    WHERE id IN ${ids(3)} AND attempts = 0 AND status = 'pending' RETURNING id`,
  // `=`, not `IN`: Postgres may run an IN subquery once per row, and lock a new row each time
  claimDue: `
    UPDATE logic_jobs SET attempts = attempts + 1, receipt = $1, claimed_at = now(), available_at = ${inSeconds(2)}
    WHERE id = (SELECT id FROM logic_jobs WHERE status = 'pending' AND available_at <= now() ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING job::text AS job, attempts`,
  extend: `UPDATE logic_jobs SET available_at = ${inSeconds(1)} WHERE ${mine(2)}`,
  backOff: `UPDATE logic_jobs SET available_at = ${inSeconds(1)}, last_error = $2, claimed_at = NULL WHERE ${mine(3)}`,
  markFailed: `UPDATE logic_jobs SET status = 'failed', last_error = $1, failed_at = now(), claimed_at = NULL WHERE ${mine(2)}`,
  remove: `DELETE FROM logic_jobs WHERE ${mine(1)}`,
  // its receipt goes, so the runner that lost it can't finish the new run. Its key goes: it has run, so it's no longer
  // a call a newer one replaces (and one may be waiting with it)
  retry: `
    UPDATE logic_jobs SET status = 'pending', attempts = 0, receipt = NULL, claimed_at = NULL, available_at = now(), last_error = NULL, failed_at = NULL, replace_key = NULL
    WHERE id = $1 AND status = 'failed' RETURNING id`,
  fail: `
    INSERT INTO logic_jobs (id, job, status, last_error, failed_at) VALUES ($1, $2::text::jsonb, 'failed', $3, now())
    ON CONFLICT (id) DO UPDATE SET status = 'failed', last_error = excluded.last_error, failed_at = excluded.failed_at`,
  // field by field, as SQLite matches, so both databases agree; `failed_at` back as text to the microsecond, for the cursor
  failed: `
    WITH p AS (SELECT NULLIF($1, '') AS source, NULLIF($2, '') AS want, NULLIF($3, '')::timestamptz AS at, NULLIF($4, '') AS after_id)
    SELECT j.id, j.job::text AS job, j.last_error, to_char(j.failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS failed_at
    FROM logic_jobs j, p
    WHERE j.status = 'failed'
      AND (p.source IS NULL OR coalesce(j.job ->> 'listener', j.job ->> 'cron', j.job ->> 'fn') = p.source)
      AND (p.want IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.want::jsonb) AS w(m)
        WHERE (coalesce(j.job -> 'scope', j.job #> '{envelope,scope}') #> ARRAY(SELECT jsonb_array_elements_text(w.m -> 'path'))) IS DISTINCT FROM (w.m -> 'value')))
      AND (p.at IS NULL OR (j.failed_at, j.id) < (p.at, p.after_id))
    ORDER BY j.failed_at DESC, j.id DESC
    LIMIT $5::int`,
  forget: `DELETE FROM logic_jobs WHERE id = $1 AND status = 'failed' RETURNING id`,
  take: `DELETE FROM logic_jobs WHERE id = $1 AND status = 'failed' RETURNING job::text AS job`,
};

/**
 * Your database as the queue, like Laravel's `database` driver: jobs are rows written in the mutation's transaction, so
 * a committed one is never lost. After commit the request runs them (through `waitUntil` on serverless), so no worker
 * is needed; `sweep` picks up what a crash or a failure left behind. At least once: a crash between a job finishing and
 * its row being deleted runs it again.
 *
 * ```ts
 * const registry = createRegistry({ modules, database, jobs: { adapter: databaseQueue(), scope: { store, load } } });
 * startTicking(registry); // from logic-sdk/node, or registry.jobs.sweep() from a platform's cron trigger
 * ```
 */
export const databaseQueue = (options: DatabaseQueueOptions = {}): StoredJobs => storedJobs(statements, options);

/**
 * The outbox pattern: a table in front of another queue. Jobs are rows written in the mutation's transaction, kept only
 * until `queue` has them: the jobs of one commit go in one send. Then the queue runs them and redelivers what throws;
 * one that fails for good comes back here as a failed row. A send that lands but whose row isn't deleted is sent again,
 * so a job can run twice, even at once.
 *
 * ```ts
 * jobs: { adapter: outbox(cloudflareQueue(env.JOBS)), scope: { store, load } }
 * ```
 */
export const outbox = (queue: JobsAdapter, options: OutboxOptions = {}): StoredJobs => storedJobs(statements, options, queue);

/**
 * Failed jobs in your jobs table, for a queue that can't keep them itself: `jobs: { adapter: cloudflareQueue(env.JOBS),
 * failed: failedJobs() }`. Like Laravel's `failed` driver. `databaseQueue` and `outbox` keep their own.
 */
export const failedJobs = (): FailedJobs => failedStore(statements);
