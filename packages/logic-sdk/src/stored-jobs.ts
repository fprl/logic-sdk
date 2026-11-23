// Jobs in your database, written in the mutation's transaction: run from there (databaseQueue), or kept until a queue
// has them (outbox). The table's statements are SQL, one set per database (postgres.ts, sqlite.ts), and run through
// the database adapter's `query`, so this file knows no ORM and no driver.
import { replaceKeyOf, type Job, type JobOutcome, type JobsAdapter, type Runner, type SqlDatabase, type SweepResult } from "./index.ts";

/**
 * The table's statements for one database. Parameters are strings and numbers only, so no driver has to guess a type:
 * lists of ids and rows travel as one JSON string, times as seconds from the database's clock. Each appears once, in
 * the order written here, so a database with positional `?` works too. Each returns the columns named, lowercase.
 */
export interface JobsSql {
  /** `(pickup, rows)`: rows is JSON `[{ id, job, at, key }]`, `at` in epoch ms or null (due now, a sweep's after `pickup` seconds). A waiting row with the same `key` becomes the new one. */
  insert: string;
  /** `(ids)`: records cron ticks nobody recorded yet. Returns `id`. */
  recordTicks: string;
  /** `()`: forgets ticks older than a day. */
  pruneTicks: string;
  /** `(receipt, lease, ids)`: the first claim, of rows nobody claimed. Returns `id`. */
  claimNew: string;
  /** `(receipt, lease)`: claims the one row due first. Returns `job` (JSON text) and `attempts`. */
  claimDue: string;
  /** `(lease, ids, receipt)`, on rows this receipt still owns, like the three below. */
  extend: string;
  /** `(seconds, error, ids, receipt)` */
  backOff: string;
  /** `(error, ids, receipt)` */
  markFailed: string;
  /** `(ids, receipt)` */
  remove: string;
  /** `(id)`: a failed row back in line. Returns `id`. */
  retry: string;
  /** `(id, job, error)`: a failed row, new or over the one there. */
  fail: string;
}

/** Seconds a job due now waits for the request that queued it, before a sweep may take it: how soon a crash after commit is noticed. */
const PICKUP = 30;

/**
 * Seconds a runner keeps extending a job's lease: the limit of a Workers cron or queue consumer, and pg-boss's default
 * expiry. Past it, a job that hangs is taken over like a crashed one. A longer job needs a `lease` that long.
 */
const MAX_EXTEND = 15 * 60;

/** Who owns a job while it runs. */
interface Claim {
  receipt: string;
  attempt: number;
}

export interface DatabaseQueueOptions {
  /**
   * Seconds a runner owns a job before a sweep may take it over: how soon a crash is noticed. Default 300. A running
   * job extends it every third of it, for 15 minutes, so it needn't cover your slowest listener, unless one takes
   * longer than that.
   */
  lease?: number;
  /** Seconds to wait after a failed try. Default `Math.exp(Math.min(attempt, 10))`, the curve Graphile Worker uses. */
  backoff?: (attempt: number) => number;
}

export interface OutboxOptions {
  /** Seconds a send owns its jobs: how soon one that crashed is sent again. Default 300. */
  lease?: number;
  /** Seconds to wait after a failed send. Default `Math.exp(Math.min(attempt, 10))`, the curve Graphile Worker uses. */
  backoff?: (attempt: number) => number;
  /**
   * Failed sends before the row is marked failed. Default 10: about 3.5 hours of backoff in all. A listener's own tries
   * are its `attempts`.
   */
  maxAttempts?: number;
}

/** What `databaseQueue` and `outbox` return. You call it through the registry: `registry.jobs.sweep()`, `registry.jobs.retry(id)`. */
export interface StoredJobs extends JobsAdapter {
  /** What's due (retries, delayed jobs, what a crash left behind), claimed one at a time. */
  sweep(runner: Runner, options?: { limit?: number }): Promise<SweepResult>;
  /** Put a failed row back in line, with a fresh set of attempts. `false` when no failed row has that id. */
  retry(id: string): Promise<boolean>;
}

/** Both: rows in `logic_jobs`, claimed by receipt. Without `via` they run here; with it they're sent. */
export function storedJobs(sql: JobsSql, database: SqlDatabase, options: OutboxOptions, via?: JobsAdapter): StoredJobs {
  const lease = options.lease ?? 300;
  const maxAttempts = options.maxAttempts ?? 10;
  const backoff = options.backoff ?? ((attempt: number) => Math.exp(Math.min(attempt, 10)));
  /** Outside a mutation: on the database itself. */
  const query = (text: string, params: unknown[]) => database.query(database.db, text, params);
  const list = (ids: string[]) => JSON.stringify(ids);

  // These three only land on rows still pending under this claim (each statement says so): a slow runner can't undo a
  // newer runner's work, and a handoff that finishes late can't delete the failure a consumer already recorded. By
  // receipt, not attempt number: `retry(id)` starts those again at 1.
  const markFailed = (ids: string[], claim: Claim, error: unknown) => query(sql.markFailed, [describe(error), list(ids), claim.receipt]);
  const backOff = (ids: string[], claim: Claim, error: unknown) => query(sql.backOff, [backoff(claim.attempt), describe(error), list(ids), claim.receipt]);
  const remove = (ids: string[], claim: Claim) => query(sql.remove, [list(ids), claim.receipt]);

  /**
   * While a job runs, its lease is extended, as Laravel Cloud does on SQS: a slow job stays its runner's, and a dead
   * runner's job is free a lease later. Returns the stop, which waits for the extension on its way: landing after a
   * backoff, it would replace the backoff.
   */
  function keepExtending(job: Job, claim: Claim, runner: Runner): () => Promise<unknown> {
    const until = Date.now() + MAX_EXTEND * 1000;
    let extending: Promise<unknown> = Promise.resolve();
    const timer = setInterval(
      () => {
        if (Date.now() >= until) return clearInterval(timer);
        extending = extending
          .then(() => query(sql.extend, [lease, list([job.id]), claim.receipt]))
          .catch((e) => runner.report(e, job, claim.attempt));
      },
      (lease * 1000) / 3,
    );
    return () => {
      clearInterval(timer);
      return extending;
    };
  }

  /**
   * Run one claimed job here and record how it went. The core decides: `failed` (its `fail` wrote the row), a throw
   * (tries left: back off), or done and discarded (delete the row).
   */
  async function run(job: Job, claim: Claim, runner: Runner): Promise<keyof SweepResult> {
    const stopExtending = keepExtending(job, claim, runner);
    let outcome: JobOutcome;
    try {
      outcome = await runner
        .run(job, {
          attempt: claim.attempt,
          fail: async (error) => {
            await markFailed([job.id], claim, error);
          },
        })
        .finally(stopExtending);
    } catch (e) {
      await backOff([job.id], claim, e);
      return "retrying";
    }
    if (outcome !== "failed") await remove([job.id], claim);
    return outcome;
  }

  /** Hand claimed jobs to `via` in one send. Done once the queue has them; a failed send keeps them all for a retry. */
  async function handOff(queue: JobsAdapter, jobs: Job[], claim: Claim, runner: Runner): Promise<keyof SweepResult> {
    const ids = jobs.map((j) => j.id);
    try {
      await queue.deliver(jobs, runner);
    } catch (e) {
      for (const job of jobs) runner.report(e, job, claim.attempt); // the queue's failure, not the listener's: run never saw it
      if (claim.attempt >= maxAttempts) {
        await markFailed(ids, claim, e);
        return "failed";
      }
      await backOff(ids, claim, e);
      return "retrying";
    }
    await remove(ids, claim);
    return "done";
  }

  /** A cron's minute runs once: records the ticks no one recorded yet and returns their ids. Prunes old ones. */
  async function recordTicks(tx: unknown, ticks: Job[]): Promise<Set<unknown>> {
    if (!ticks.length) return new Set();
    const first = await database.query(tx, sql.recordTicks, [list(ticks.map((j) => j.id))]);
    await database.query(tx, sql.pruneTicks, []);
    return new Set(first.map((row) => row.id));
  }

  const settle = (job: Job, claim: Claim, runner: Runner) => (via ? handOff(via, [job], claim, runner) : run(job, claim, runner));

  /** The first claim of jobs just committed, by the request that queued them: the ones no sweep took meanwhile. */
  async function claimNew(jobs: Job[]): Promise<{ claim: Claim; won: Job[] }> {
    const claim = { receipt: crypto.randomUUID(), attempt: 1 };
    const rows = await query(sql.claimNew, [claim.receipt, lease, list(jobs.map((j) => j.id))]);
    const ids = new Set(rows.map((row) => row.id));
    return { claim, won: jobs.filter((j) => ids.has(j.id)) }; // in emit order: RETURNING has none
  }

  return {
    holds: true, // rows wait until they're due, however long, so `via`'s limits on delays don't apply
    replaces: true, // a waiting row is replaced in place; under `via` too, since rows wait here until they're due
    /** Must share the transaction it writes in. */
    check({ database: given }) {
      if (given && given.db !== database.db)
        throw new Error(
          `[logic-sdk] ${via ? "outbox(database, queue)" : "databaseQueue(database)"} must use the same database as \`database\`: jobs are written in your mutation's transaction. ` +
            "A queue in another database goes behind an outbox: outbox(database, queue).",
        );
    },
    /**
     * Inside the mutation's transaction: one unclaimed row per job. Due now: a sweep leaves it `PICKUP` seconds to this
     * request. Delayed: available from `runAt`, for a sweep. A cron's minute runs once: only ticks nobody recorded yet.
     */
    async enqueue(tx, jobs) {
      const firstTicks = await recordTicks(tx, jobs.filter((j) => j.kind === "cron"));
      const rows = jobs
        .filter((j) => j.kind !== "cron" || firstTicks.has(j.id))
        .map((j) => ({ id: j.id, job: j, at: j.runAt ? Date.parse(j.runAt) : null, key: replaceKeyOf(j) ?? null }))
        // in key order, so two transactions replacing the same keys lock them in the same order and can't deadlock
        .sort((a, b) => byText(a.key ?? "", b.key ?? ""));
      if (rows.length) await database.query(tx, sql.insert, [PICKUP, JSON.stringify(rows)]);
    },
    /**
     * After commit, in this request: each job is claimed just before it runs, so a slow or dead one doesn't spend the
     * others' attempt. Under `via` they're claimed together, for one send. What isn't claimed yet when the process dies
     * is a sweep's, as a first try.
     */
    async deliver(jobs, runner) {
      const due = jobs.filter((j) => !j.runAt);
      if (!due.length) return;
      if (via) {
        const { claim, won } = await claimNew(due);
        if (won.length) await handOff(via, won, claim, runner);
        return;
      }
      for (const job of due) {
        try {
          const { claim, won } = await claimNew([job]);
          if (won.length) await run(job, claim, runner);
        } catch (e) {
          runner.report(e, job, 1); // its bookkeeping failed (a lost connection): a sweep sorts it out, and the others still run
        }
      }
    },
    /** One at a time, so every claim gets a full lease and a job the queue rejects (too big) can't hold back the others. */
    async sweep(runner, { limit = 100 } = {}) {
      const result: SweepResult = { done: 0, failed: 0, discarded: 0, retrying: 0 };
      for (let i = 0; i < limit; i++) {
        const receipt = crypto.randomUUID();
        const [row] = await query(sql.claimDue, [receipt, lease]);
        if (!row) break;
        const job: Job = JSON.parse(String(row.job)); // claimDue returns it as JSON text, on every driver
        const attempt = Number(row.attempts);
        try {
          result[await settle(job, { receipt, attempt }, runner)]++;
        } catch (e) {
          runner.report(e, job, attempt); // its bookkeeping failed (a lost connection): its lease brings it back
        }
      }
      return result;
    },
    /** Failed rows only: a pending one belongs to its runner or a sweep, and resetting it could run it twice at once. */
    async retry(id) {
      return (await query(sql.retry, [id])).length > 0;
    },
    /** A job that failed for good in a queue consumer: keep it as a failed row, so you can query it and `retry` it. */
    async fail(job, error) {
      await query(sql.fail, [job.id, JSON.stringify(job), describe(error)]);
    },
  };
}

/** Not `localeCompare`: processes with another locale would lock in another order. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e)); // a stack starts with the message
