import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { replaceKeyOf, type DatabaseAdapter, type DeliveryOutcome, type Dispatcher, type Job, type ReadWrite, type Runner, type SweepResult } from "./index.ts";

/** Anything with Drizzle's `transaction(fn)`: a database or a transaction (nested = savepoint). */
interface Transactional {
  transaction<T>(fn: (tx: any) => Promise<T>, config?: any): Promise<T>;
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

/**
 * Use a Drizzle database for mutations. Needs a driver with async interactive transactions: node-postgres, postgres.js,
 * PGlite, Neon websocket, Hyperdrive. Not D1 or HTTP drivers, and not Drizzle's synchronous SQLite drivers
 * (better-sqlite3, bun:sqlite, node:sqlite, Durable Objects): they commit before an async mutation finishes, and
 * Drizzle's types already reject them here. Not a local libsql file either: overlapping mutations fail (SQLITE_BUSY).
 */
export function drizzleAdapter<Db extends Transactional>(db: Db): DatabaseAdapter<Db, DrizzleTx<Db>> {
  return {
    db,
    transactions: "interactive",
    transaction: (fn) => db.transaction(fn),
    nest: (tx) => drizzleAdapter(tx),
    retryable: (e) => RETRYABLE.has(sqlState(e) ?? ""),
  };
}

/** Postgres: serialization_failure, deadlock_detected. The transaction lost a race; running it again is the fix. */
const RETRYABLE = new Set(["40001", "40P01"]);

/** The SQLSTATE of a driver error, also when Drizzle wraps it (`DrizzleQueryError.cause`). Use it to map constraints. */
export function sqlState(error: unknown): string | undefined {
  for (let e: any = error, i = 0; e && i < 5; e = e.cause, i++) if (typeof e.code === "string") return e.code;
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Jobs in your database, written in the mutation's transaction: run from there (databaseQueue), or kept until a queue
 * has them (outbox)
 * ──────────────────────────────────────────────────────────────────────────── */

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

/** Rows not claimed yet: what `replace` may still replace. */
const waiting = sql`status = 'pending' and attempts = 0`;

/**
 * The table behind `databaseQueue` and `outbox` (Postgres), Laravel's `jobs`. Re-export it from your schema so
 * drizzle-kit adds it to your migrations: `export { jobsTable } from "logic-sdk/drizzle";`. One row per pending job;
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
export interface StoredJobs extends Dispatcher {
  /** What's due (retries, delayed jobs, what a crash left behind), claimed one at a time. */
  sweep(runner: Runner, options?: { limit?: number }): Promise<SweepResult>;
  /** Put a failed row back in line, with a fresh set of attempts. `false` when no failed row has that id. */
  retry(id: string): Promise<boolean>;
}

/** Anything Drizzle that can run these queries: your database, or the mutation's transaction. */
type PgClient = Pick<PgAsyncDatabase<PgQueryResultHKT>, "insert" | "update" | "delete" | "select">;

/**
 * Your database as the queue, like Laravel's `database` driver: jobs are rows written in the mutation's transaction, so
 * a committed one is never lost. After commit the request runs them (through `waitUntil` on serverless), so no worker
 * is needed; `sweep` picks up what a crash or a failure left behind. At least once: a crash between a job finishing and
 * its row being deleted runs it again.
 *
 * ```ts
 * const registry = createRegistry({ modules, database: drizzleAdapter(db), jobs: { adapter: databaseQueue(db), scope: { store, load } } });
 * startTicking(registry); // from logic-sdk/node, or registry.jobs.sweep() from a platform's cron trigger
 * ```
 */
export function databaseQueue(db: PgClient, options: DatabaseQueueOptions = {}): StoredJobs {
  return storedJobs(db, options);
}

/**
 * The outbox pattern: a table in front of another queue. Jobs are rows written in the mutation's transaction, kept only
 * until `queue` has them: the jobs of one commit go in one send. Then the queue runs them and redelivers what throws;
 * one that fails for good comes back here as a failed row. A send that lands but whose row isn't deleted is sent again,
 * so a job can run twice, even at once.
 *
 * ```ts
 * jobs: { adapter: outbox(db, cloudflareQueue(env.JOBS)), scope: { store, load } }
 * ```
 */
export function outbox(db: PgClient, queue: Dispatcher, options: OutboxOptions = {}): StoredJobs {
  return storedJobs(db, options, queue);
}

/** Both: rows in `jobsTable`, claimed by receipt. Without `via` they run here; with it they're sent. */
function storedJobs(db: PgClient, options: OutboxOptions, via?: Dispatcher): StoredJobs {
  const lease = options.lease ?? 300;
  const maxAttempts = options.maxAttempts ?? 10;
  const backoff = options.backoff ?? ((attempt: number) => Math.exp(Math.min(attempt, 10)));
  const t = jobsTable;
  const inSeconds = (seconds: number) => sql`now() + make_interval(secs => ${seconds})`;
  /**
   * Writes only land on rows still pending under this claim: a slow runner can't undo a newer runner's work, and a
   * handoff that finishes late can't delete the failure a consumer already recorded. By receipt, not attempt number:
   * `retry(id)` starts those again at 1.
   */
  const mine = (ids: string[], { receipt }: Claim) => and(inArray(t.id, ids), eq(t.receipt, receipt), eq(t.status, "pending"));

  const asFailed = (error: unknown) => ({ status: "failed" as const, lastError: describe(error), failedAt: sql`now()` });
  const markFailed = (ids: string[], claim: Claim, error: unknown) => db.update(t).set(asFailed(error)).where(mine(ids, claim));
  const backOff = (ids: string[], claim: Claim, error: unknown) =>
    db.update(t).set({ availableAt: inSeconds(backoff(claim.attempt)), lastError: describe(error) }).where(mine(ids, claim));

  /**
   * While a job runs, its lease is extended, as Laravel Cloud does on SQS: a slow job stays its runner's, and a dead
   * runner's job is free a lease later. Returns the stop, which waits for the extension on its way: landing after a
   * backoff, it would replace the backoff.
   */
  function keepExtending(job: Job, claim: Claim, runner: Runner): () => Promise<void> {
    const until = Date.now() + MAX_EXTEND * 1000;
    let extending = Promise.resolve();
    const timer = setInterval(
      () => {
        if (Date.now() >= until) return clearInterval(timer);
        extending = extending
          .then(async () => {
            await db.update(t).set({ availableAt: inSeconds(lease) }).where(mine([job.id], claim));
          })
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
    let outcome: DeliveryOutcome;
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
    if (outcome !== "failed") await db.delete(t).where(mine([job.id], claim));
    return outcome;
  }

  /** Hand claimed jobs to `via` in one send. Done once the queue has them; a failed send keeps them all for a retry. */
  async function handOff(queue: Dispatcher, jobs: Job[], claim: Claim, runner: Runner): Promise<keyof SweepResult> {
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
    await db.delete(t).where(mine(ids, claim));
    return "done";
  }

  /** A cron's minute runs once: records the ticks no one recorded yet and returns their ids. Prunes old ones. */
  async function recordTicks(client: PgClient, ticks: Job[]): Promise<Set<string>> {
    if (!ticks.length) return new Set();
    const first = await client
      .insert(cronRunsTable)
      .values(ticks.map((j) => ({ id: j.id })))
      .onConflictDoNothing()
      .returning({ id: cronRunsTable.id });
    await client.delete(cronRunsTable).where(lt(cronRunsTable.ranAt, sql`now() - interval '1 day'`));
    return new Set(first.map((row) => row.id));
  }

  const settle = (job: Job, claim: Claim, runner: Runner) => (via ? handOff(via, [job], claim, runner) : run(job, claim, runner));

  /** The first claim of jobs just committed, by the request that queued them: the ones no sweep took meanwhile. */
  async function claimNew(jobs: Job[]): Promise<{ claim: Claim; won: Job[] }> {
    const claim = { receipt: crypto.randomUUID(), attempt: 1 };
    const rows = await db
      .update(t)
      .set({ attempts: 1, receipt: claim.receipt, availableAt: inSeconds(lease) })
      .where(and(inArray(t.id, jobs.map((j) => j.id)), eq(t.attempts, 0), eq(t.status, "pending")))
      .returning({ id: t.id });
    const ids = new Set(rows.map((row) => row.id));
    return { claim, won: jobs.filter((j) => ids.has(j.id)) }; // in emit order: RETURNING has none
  }

  return {
    holds: true, // rows wait until they're due, however long, so `via`'s limits on delays don't apply
    replaces: true, // a waiting row is replaced in place; under `via` too, since rows wait here until they're due
    /** Must share the transaction it writes in. */
    check({ database }) {
      if (database && database.db !== db)
        throw new Error(
          `[logic-sdk] ${via ? "outbox(db, queue)" : "databaseQueue(db)"} must use the same database as \`database\`: jobs are written in your mutation's transaction. ` +
            "A queue in another database goes behind an outbox: outbox(db, queue).",
        );
    },
    /**
     * Inside the mutation's transaction: one unclaimed row per job. Due now: a sweep leaves it `PICKUP` seconds to this
     * request. Delayed: available from `runAt`, for a sweep.
     */
    async enqueue(tx, jobs) {
      const client = tx as PgClient; // SAFETY: check() refuses a database that isn't this db, so tx is its transaction
      const firstTicks = await recordTicks(client, jobs.filter((j) => j.kind === "cron"));
      const row = (j: Job) => ({
        id: j.id,
        job: j,
        attempts: 0,
        availableAt: j.runAt ? new Date(j.runAt) : inSeconds(PICKUP),
        replaceKey: replaceKeyOf(j) ?? null,
      });
      const rows = jobs.filter((j) => j.kind !== "cron" || firstTicks.has(j.id)).map(row);
      const plain = rows.filter((r) => r.replaceKey === null);
      // in key order, so two transactions replacing the same keys lock them in the same order and can't deadlock
      const replacing = rows
        .filter((r): r is typeof r & { replaceKey: string } => r.replaceKey !== null)
        .sort((a, b) => a.replaceKey.localeCompare(b.replaceKey));
      if (plain.length) await client.insert(t).values(plain);
      // the waiting call with this key becomes the new one: its id, job and time (Oban's `replace`)
      if (replacing.length)
        await client
          .insert(t)
          .values(replacing)
          .onConflictDoUpdate({
            target: t.replaceKey,
            targetWhere: waiting,
            set: { id: sql`excluded.id`, job: sql`excluded.job`, availableAt: sql`excluded.available_at`, lastError: null },
          });
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
    /** One at a time, so a job the queue rejects (too big) can't hold back the others. */
    async sweep(runner, { limit = 100 } = {}) {
      const result: SweepResult = { done: 0, failed: 0, discarded: 0, retrying: 0 };
      for (let i = 0; i < limit; i++) {
        const due = db
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.status, "pending"), lte(t.availableAt, sql`now()`)))
          .orderBy(t.availableAt)
          .limit(1)
          .for("update", { skipLocked: true });
        const receipt = crypto.randomUUID();
        const [row] = await db
          .update(t)
          .set({ attempts: sql`${t.attempts} + 1`, receipt, availableAt: inSeconds(lease) })
          .where(eq(t.id, due)) // `=`, not `IN`: Postgres may run an IN subquery once per row, and lock a new row each time
          .returning({ job: t.job, attempt: t.attempts });
        if (!row) break;
        try {
          result[await settle(row.job, { receipt, attempt: row.attempt }, runner)]++;
        } catch (e) {
          runner.report(e, row.job, row.attempt); // its bookkeeping failed (a lost connection): its lease brings it back
        }
      }
      return result;
    },
    /** Failed rows only: a pending one belongs to its runner or a sweep, and resetting it could run it twice at once. */
    async retry(id) {
      const revived = await db
        .update(t)
        // its receipt goes, so the runner that lost it can't finish the new run. Its key goes: it has run, so it's no
        // longer a call a newer one replaces (and one may be waiting with it)
        .set({ status: "pending", attempts: 0, receipt: null, availableAt: sql`now()`, lastError: null, failedAt: null, replaceKey: null })
        .where(and(eq(t.id, id), eq(t.status, "failed")))
        .returning({ id: t.id });
      return revived.length > 0;
    },
    /** A job that failed for good in a queue consumer: keep it as a failed row, so you can query it and `retry` it. */
    async fail(job, error) {
      const failure = asFailed(error);
      await db
        .insert(t)
        .values({ id: job.id, job, ...failure })
        .onConflictDoUpdate({ target: t.id, set: failure });
    },
  };
}

const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e)); // a stack starts with the message
