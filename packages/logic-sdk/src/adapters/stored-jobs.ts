// Jobs in the registry's database, written in the mutation's transaction: run from there (databaseQueue), or kept
// until a queue has them (outbox). The table's statements are SQL, one set per database (postgres.ts, sqlite.ts), and run through
// the database adapter's `query`, so this file knows no ORM and no driver.
import { defaultBackoff, storedUniqueKey } from "../core/jobs.ts";
import type { AdapterSetup, FailedJobs, FailedQuery, FailedRow, Job, JobOutcome, JobsAdapter, Runner, SqlDatabase, SweepOptions, SweepResult } from "../core/types.ts";

/**
 * The table's statements for one database. Parameters are strings and numbers only, so no driver has to guess a type:
 * lists of ids and rows travel as one JSON string, times as seconds from the database's clock. Each appears once, in
 * the order written here, so a database with positional `?` works too. Each returns the columns named, lowercase.
 */
export interface JobsSql {
  /**
   * `(pickup, rows)`: rows is JSON `[{ id, job, at, unique, order }]`, `at` in epoch ms or null (due now, a sweep's
   * after `pickup` seconds). A waiting row with the same `unique` is replaced by a call, and kept over a delivery.
   */
  insert: string;
  /** `(ids)`: records cron ticks nobody recorded yet. Returns `id`. */
  recordTicks: string;
  /** `()`: forgets ticks older than a day. */
  pruneTicks: string;
  /** `(receipt, lease, id)`: the first claim, of a row nobody claimed. Returns `id`. */
  claimNew: string;
  /**
   * `(receipt, lease, grace, queue)`: claims the one row due first (`grace` seconds ago) in `queue` (`''`: any; a job
   * without one is in `"default"`), the first open one of its key. Returns `job` (JSON text) and `attempts`.
   */
  claimDue: string;
  /** `(receipt, lease, id)`: claims the row a signal names, if it's due. Returns `job` and `attempts`. */
  claimOne: string;
  /** `(receipt, lease, order)`: claims the next row of a key, due or waiting only for its turn. Returns `job` and `attempts`. */
  claimNext: string;
  /** `(lease, id, receipt)`, on a row this receipt still owns, like the three below. */
  extend: string;
  /** `(seconds, error, id, receipt)` */
  backOff: string;
  /** `(error, id, receipt)` */
  markFailed: string;
  /** `(id, receipt)` */
  remove: string;
  /** `(id)`: a failed row back in line. Returns `id`. */
  retry: string;
  /** `(id, job, error)`: a failed row, new or over the one there. */
  fail: string;
  /**
   * `(source, matches, at, id, limit)`, `''` for "any": failed rows newest first, after the cursor row (`at`, `id`), each
   * matching the source and every field in `matches` (JSON `[{ path, jsonPath, value }]`). Returns `id`, `job` (JSON
   * text), `last_error` and `failed_at` (as `at` takes it back).
   */
  failed: string;
  /** `(id)`: deletes a failed row. Returns `id`. */
  forget: string;
  /** `(id)`: deletes a failed row. Returns `job` (JSON text). */
  take: string;
}

/**
 * Seconds a job due now waits for the request that queued it before a sweep may take it (how soon a crash after
 * commit is noticed). Behind an outbox, also how long past due a sweep leaves a row to its signal.
 */
const PICKUP = 30;

/** A signal for a later time goes out this much later, so a clock ahead of the database's doesn't land it early. */
const SLACK = 1000;

/**
 * Seconds a runner keeps extending a job's lease: the limit of a Workers cron or queue consumer. Past it, a job that
 * hangs is taken over like a crashed one. A longer job needs a `lease` that long.
 */
const MAX_EXTEND = 15 * 60;

/**
 * Seconds a queue consumer keeps running one key's jobs before it hands the rest to the next message: one busy key
 * can't hold a consumer, and the messages behind it, until the platform stops it.
 */
const DRAIN = 60;

/** A delivery's `key`: its jobs run one at a time, in insert order. */
const keyOf = (job: Job) => (job.kind === "delivery" ? job.key : undefined);

/** Who owns a job while it runs. */
interface Claim {
  receipt: string;
  attempt: number;
}

export interface OutboxOptions {
  /**
   * Seconds a runner owns a job before a sweep may take it over: how soon a crash is noticed. Default 300. A running
   * job extends it every third of it, for 15 minutes, so it needn't cover your slowest listener, unless one takes
   * longer than that.
   */
  lease?: number;
  /** Seconds to wait after a failed try. Default `defaultBackoff`, the curve Graphile Worker uses. */
  backoff?: (attempt: number) => number;
}

export interface DatabaseQueueOptions extends OutboxOptions {
  /**
   * Who runs a job due now. `"request"` (default): the request that committed it, right after commit (after the
   * response, with `waitUntil`), unless `work(registry)` runs in this process: then that loop takes it, and the request
   * answers at once. `"worker"`: workers in other processes run every job, and requests only write rows.
   */
  runIn?: "request" | "worker";
}

/** What `databaseQueue` and `outbox` return. You call it through the registry: `registry.jobs.sweep()`, `registry.jobs.retry(id)`. */
export interface StoredJobs extends JobsAdapter {
  /** What's due (retries, delayed jobs, what a crash left behind), claimed one at a time. */
  sweep(runner: Runner, options?: SweepOptions): Promise<SweepResult>;
  /** Put a failed row back in line, with a fresh set of attempts. `false` when no failed row has that id. */
  retry(id: string): Promise<boolean>;
  /** A page of failed rows, newest first. */
  failed(query: FailedQuery): Promise<{ rows: FailedRow[]; cursor: string | null }>;
  /** Delete a failed row. `false` when no failed row has that id. */
  forget(id: string): Promise<boolean>;
}

/**
 * The registry's database, taken at `createRegistry` (`sql: true`, so the core refuses one that doesn't run SQL): jobs
 * are rows written in the mutation's transaction, so there's no other database they could go to. Laravel's `database`
 * driver uses the app's connection too.
 */
function registryDatabase(name: string) {
  let database: SqlDatabase | undefined;
  let workers: AdapterSetup["workers"] = { takes: () => false, wake: () => {} };
  return {
    connect(setup: AdapterSetup) {
      const { sql } = setup;
      if (database && sql && database.db !== sql.db)
        throw new Error(`[logic-sdk] ${name} is already connected to another registry's database: call it once per registry.`);
      database = sql;
      workers = setup.workers;
    },
    /** The loops running jobs in this process (`work()`). */
    workers: () => workers,
    get(): SqlDatabase {
      if (!database) throw new Error(`[logic-sdk] ${name} isn't connected: pass it to createRegistry.`);
      return database;
    },
  };
}

/** Both: rows in `logic_jobs`, claimed by receipt. Without `via` they run here; with it, the queue carries signals. */
export function storedJobs(sql: JobsSql, options: DatabaseQueueOptions, via?: JobsAdapter): StoredJobs {
  const name = via ? "outbox(queue)" : "databaseQueue()";
  // its jobs would be signalled to a `deliver` that has nothing to do
  if (via?.enqueue)
    throw new Error(`[logic-sdk] outbox(queue) got a queue that writes its jobs in your transaction itself (it has \`enqueue\`): use it on its own, without an outbox.`);
  const database = registryDatabase(name);
  const lease = options.lease ?? 300;
  const backoff = options.backoff ?? defaultBackoff;
  const inWorker = options.runIn === "worker";
  /**
   * Whether this request leaves its jobs due now to workers: always with `runIn: "worker"`, and when a loop in this
   * process takes every one of them. Asked the same way at insert and after commit, so the row is free for it at once.
   */
  const leaves = (jobs: Job[]) => inWorker || jobs.filter((j) => !j.runAt).every((j) => database.workers().takes(j));
  /** Outside a mutation: on the database itself. */
  const query = (text: string, params: unknown[]) => database.get().query(database.get().db, text, params);
  const list = (ids: string[]) => JSON.stringify(ids);

  // These three only land on rows still pending under this claim (each statement says so): a slow runner can't undo a
  // newer runner's work. By receipt, not attempt number: `retry(id)` starts those again at 1.
  const failedRows = rowsOfFailed(sql, query);
  const markFailed = (job: Job, claim: Claim, error: unknown) => query(sql.markFailed, [describe(error), job.id, claim.receipt]);
  const backOff = (job: Job, claim: Claim, seconds: number, error: unknown) => query(sql.backOff, [seconds, describe(error), job.id, claim.receipt]);
  const remove = (job: Job, claim: Claim) => query(sql.remove, [job.id, claim.receipt]);

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
          .then(() => query(sql.extend, [lease, job.id, claim.receipt]))
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
   * (tries left: back off, and behind an outbox signal the retry), or done and discarded (delete the row).
   */
  async function run(job: Job, claim: Claim, runner: Runner): Promise<keyof SweepResult> {
    const stopExtending = keepExtending(job, claim, runner);
    let outcome: JobOutcome;
    try {
      outcome = await runner
        .run(job, {
          attempt: claim.attempt,
          fail: async (error) => {
            await markFailed(job, claim, error);
          },
        })
        .finally(stopExtending);
    } catch (e) {
      const seconds = backoff(claim.attempt);
      await backOff(job, claim, seconds, e);
      if (via) await signal([{ ...job, runAt: new Date(Date.now() + seconds * 1000).toISOString() }], runner);
      return "retrying";
    }
    if (outcome !== "failed") await remove(job, claim);
    return outcome;
  }

  /**
   * Run a key's next jobs here, one by one, as they come free: after a job in the request, rather than leave them to a
   * sweep (which runs them as they're due, one per claim), and for a consumer's signal behind an outbox. There, after
   * `DRAIN` seconds the rest get one more signal.
   */
  async function runKey(key: string, runner: Runner) {
    const until = Date.now() + DRAIN * 1000;
    for (;;) {
      const receipt = crypto.randomUUID();
      const [row] = await query(sql.claimNext, [receipt, lease, key]);
      if (!row) return;
      const job: Job = JSON.parse(String(row.job));
      await run(job, { receipt, attempt: Number(row.attempts) }, runner);
      if (via && Date.now() >= until) return signal([job], runner);
    }
  }

  /**
   * Behind an outbox, a consumer got a signal: run the row it names (with a `key`, the key's next jobs). The row is the
   * truth, so a duplicate, a late one, or one whose row is gone or taken has nothing to do.
   */
  async function consume(job: Job, runner: Runner) {
    const key = keyOf(job);
    if (key) return runKey(key, runner);
    const receipt = crypto.randomUUID();
    const [row] = await query(sql.claimOne, [receipt, lease, job.id]);
    if (row) await run(JSON.parse(String(row.job)), { receipt, attempt: Number(row.attempts) }, runner);
  }

  /** Can `via` hold a signal until `at`? */
  const canHold = (at: number) => via?.holds === true || (!!via?.holds && (at - Date.now()) / 1000 <= via.holds.max);

  /**
   * Behind an outbox, every job stays a row and the queue gets a signal: whoever gets one runs the row from the table
   * (`consume`). One for a later time goes out only if the queue can hold it; a sweep runs the rest. A signal that
   * doesn't go out is reported and the rows wait for a sweep. The runner the queue gets runs signals too, for a queue
   * that runs what it's sent itself.
   */
  async function signal(jobs: Job[], runner: Runner) {
    const signals: Job[] = [];
    for (const job of jobs) {
      if (!job.runAt) signals.push(job);
      else if (canHold(Date.parse(job.runAt))) signals.push({ ...job, runAt: new Date(Date.parse(job.runAt) + SLACK).toISOString() });
    }
    if (!signals.length) return;
    const consumer: Runner = {
      ...runner,
      run: async (job) => {
        await consume(job, runner);
        return "done";
      },
    };
    try {
      await via!.deliver(signals, consumer);
    } catch (e) {
      for (const job of signals) runner.report(e, job);
    }
  }

  /** A cron's minute runs once: records the ticks no one recorded yet and returns their ids. Prunes old ones. */
  async function recordTicks(tx: unknown, ticks: Job[]): Promise<Set<unknown>> {
    if (!ticks.length) return new Set();
    const first = await database.get().query(tx, sql.recordTicks, [list(ticks.map((j) => j.id))]);
    await database.get().query(tx, sql.pruneTicks, []);
    return new Set(first.map((row) => row.id));
  }

  /** The first claim of a job just committed, by the request that queued it, unless a sweep took it meanwhile. */
  async function claimNew(job: Job): Promise<Claim | undefined> {
    const claim = { receipt: crypto.randomUUID(), attempt: 1 };
    const rows = await query(sql.claimNew, [claim.receipt, lease, job.id]);
    return rows.length ? claim : undefined;
  }

  return {
    name,
    retries: true, // a failed try backs off as a row
    holds: true, // rows wait until they're due, however long, so `via`'s limits on delays don't apply
    replaces: true, // a waiting row is replaced in place; behind an outbox too, since every job stays a row
    orders: true, // a key's jobs run from the table, in order; behind an outbox the queue only signals
    queues: true, // a row's queue is in its job: a sweep takes the ones it's asked for, in that order
    /** Takes the registry's database: it writes in the mutation's transaction. */
    sql: true,
    connect: (setup) => database.connect(setup),
    /**
     * Inside the mutation's transaction: one unclaimed row per job. Due now: a sweep leaves it `PICKUP` seconds to this
     * request, or none when the request runs nothing (workers take it, or a signal, which the sweep's grace covers). Delayed:
     * available from `runAt`. A cron's minute runs once: only ticks nobody recorded yet.
     */
    async enqueue(tx, jobs) {
      const firstTicks = await recordTicks(tx, jobs.filter((j) => j.kind === "cron"));
      const kept = jobs.filter((j) => j.kind !== "cron" || firstTicks.has(j.id));
      const rows = (await Promise.all(kept.map(async (j) => ({ id: j.id, job: j, at: j.runAt ? Date.parse(j.runAt) : null, unique: (await storedUniqueKey(j)) ?? null, order: (j.kind === "delivery" && j.key) || null }))))
        // in key order, so two transactions with the same unique keys lock them in the same order and can't deadlock
        .sort((a, b) => byText(a.unique ?? "", b.unique ?? ""));
      if (rows.length) await database.get().query(tx, sql.insert, [via || leaves(kept) ? 0 : PICKUP, JSON.stringify(rows)]);
    },
    /**
     * After commit, in this request. Behind an outbox: one signal per job, and one per key. Left to workers: wake this
     * process's, if any (others poll). Otherwise each job due now is claimed just before it runs, so a slow or dead one
     * doesn't spend the others' attempt; what isn't claimed yet when the process dies is a sweep's, as a first try.
     */
    async deliver(jobs, runner) {
      if (via) {
        const keys = new Set<string>();
        const firsts = jobs.filter((job) => {
          const key = keyOf(job);
          if (!key) return true;
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        });
        return signal(firsts, runner);
      }
      const due = jobs.filter((j) => !j.runAt);
      if (leaves(jobs)) {
        if (due.length) database.workers().wake(due.length);
        return;
      }
      for (const job of due) {
        try {
          const claim = await claimNew(job);
          if (!claim) continue;
          await run(job, claim, runner);
          const key = keyOf(job);
          if (key) await runKey(key, runner); // its key's next ones, rather than leave them to a sweep
        } catch (e) {
          runner.report(e, job, 1); // its bookkeeping failed (a lost connection): a sweep sorts it out, and the others still run
        }
      }
    },
    /**
     * What's due (retries, delayed jobs, what a crash left behind), claimed one at a time, so every claim gets a full
     * lease. Behind an outbox, only rows `PICKUP` seconds past due: until then they're their signal's.
     */
    async sweep(runner, { limit = 100, queues } = {}) {
      const result: SweepResult = { done: 0, failed: 0, discarded: 0, retrying: 0 };
      // in the order given: each claim takes the first queue with a job due, as a worker listing queues does
      const order = queues?.length ? queues : [""];
      for (let i = 0; i < limit; i++) {
        const receipt = crypto.randomUUID();
        let row: Record<string, unknown> | undefined;
        for (const queue of order) {
          [row] = await query(sql.claimDue, [receipt, lease, via ? PICKUP : 0, queue]);
          if (row) break;
        }
        if (!row) break;
        const job: Job = JSON.parse(String(row.job)); // claimDue returns it as JSON text, on every driver
        const attempt = Number(row.attempts);
        try {
          result[await run(job, { receipt, attempt }, runner)]++;
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
    ...(via ? { consume } : {}),
    failed: failedRows.failed,
    forget: failedRows.forget,
  };
}

/**
 * Failed rows, newest first, by a cursor on (failed_at, id) rather than an offset, so a script retrying page by page
 * skips none. One row past the limit says there's another page.
 */
type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

async function listFailed(sql: JobsSql, query: Query, { source, scope, limit, cursor }: FailedQuery) {
  const [at, after] = cursor === undefined ? ["", ""] : cursorOf(cursor);
  const matches = scope?.map(({ path, value }) => {
    if (path.some((key) => !key || key.includes('"'))) throw new Error(`[logic-sdk] jobs.failed({ scope }) can't match the field ${JSON.stringify(path.join("."))}.`);
    return { path, jsonPath: `$${path.map((key) => `."${key}"`).join("")}`, value };
  });
  const found = await query(sql.failed, [source ?? "", matches ? JSON.stringify(matches) : "", at, after, limit + 1]);
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((row): FailedRow => ({
      id: String(row.id),
      job: JSON.parse(String(row.job)), // JSON text, on every driver
      error: String(row.last_error ?? ""),
      failedAt: new Date(/^\d+$/.test(String(row.failed_at)) ? Number(row.failed_at) : Date.parse(String(row.failed_at))).toISOString(), // SQLite: ms; Postgres: ISO text
    })),
    cursor: found.length > limit && last ? JSON.stringify([String(last.failed_at), String(last.id)]) : null,
  };
}

/**
 * Failed jobs in the jobs table, for a queue that can't keep them itself (`cloudflareQueue` alone), like Laravel's
 * `failed` driver next to SQS. `retry` takes the row and hands the job back to the queue.
 */
export function failedStore(sql: JobsSql): FailedJobs {
  const database = registryDatabase("failedJobs()");
  const query = (text: string, params: unknown[]) => database.get().query(database.get().db, text, params);
  return {
    name: "failedJobs()",
    sql: true,
    connect: (setup) => database.connect(setup),
    ...rowsOfFailed(sql, query),
  };
}

/** Failed rows in the jobs table: kept, listed, taken back for a retry, forgotten. A waiting or running row is never touched. */
function rowsOfFailed(sql: JobsSql, query: Query) {
  return {
    async fail(job: Job, error: unknown) {
      await query(sql.fail, [job.id, JSON.stringify(job), describe(error)]);
    },
    /**
     * Newest first, by a cursor on (failed_at, id) rather than an offset, so a script retrying page by page skips none.
     * One row past the limit says there's another page.
     */
    failed: (q: FailedQuery) => listFailed(sql, query, q),
    async take(id: string): Promise<Job | undefined> {
      const [row] = await query(sql.take, [id]);
      return row ? JSON.parse(String(row.job)) : undefined;
    },
    async forget(id: string) {
      return (await query(sql.forget, [id])).length > 0;
    },
  };
}

/** A `failed` page's cursor: the last row's `failed_at` (as the database gave it) and id. */
function cursorOf(cursor: string): [string, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((part) => typeof part === "string" && part))
    throw new Error(`[logic-sdk] jobs.failed({ cursor }) takes the cursor of the page before (got ${JSON.stringify(cursor)}).`);
  return parsed as [string, string];
}

/** Not `localeCompare`: processes with another locale would lock in another order. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e)); // a stack starts with the message
