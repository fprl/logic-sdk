import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { replaceKeyOf, type DatabaseAdapter, type DeliveryOutcome, type Dispatcher, type Job, type Runner, type SweepResult } from "./index.ts";

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
 * Use a Drizzle database for mutations. Needs a driver with async interactive transactions: node-postgres, postgres.js,
 * PGlite, Neon websocket, Hyperdrive, libsql. Not D1 or HTTP drivers, and not Drizzle's synchronous SQLite drivers
 * (better-sqlite3, bun:sqlite, node:sqlite, Durable Objects): they commit before an async mutation finishes, and
 * Drizzle's types already reject them here.
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
 * Outbox: events written in the mutation's transaction, delivered after commit, retried until done
 * ──────────────────────────────────────────────────────────────────────────── */

/** Rows not claimed yet: what `replace` may still replace. */
const waiting = sql`status = 'pending' and attempts = 0`;

/**
 * The outbox table (Postgres). Re-export it from your schema so drizzle-kit adds it to your migrations:
 * `export { outboxTable } from "logic-sdk/drizzle";`. One row per pending delivery; done rows are deleted,
 * failed ones stay so you can query them and `retry` them.
 */
export const outboxTable = pgTable(
  "logic_outbox",
  {
    /** The job id: `<listener id>@<event id>`, `<cron id>@<minute>`, or `<function id>@<uuid>`. */
    id: text("id").primaryKey(),
    delivery: jsonb("delivery").$type<Job>().notNull(),
    /** `failed`: out of attempts, or a rule said no. Retrying is your call (`registry.jobs.retry(id)`). */
    status: text("status").$type<"pending" | "failed">().notNull().default("pending"),
    /** Incremented when a runner claims it, so a crash still uses an attempt. */
    attempts: integer("attempts").notNull().default(0),
    /** Due from then on. While claimed: when the lease ends and a sweep may take it over. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    /** A scheduled call's `replace` key, `<function id>@<key>`: a newer call with it replaces this row while it waits. */
    replaceKey: text("replace_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("logic_outbox_due").on(t.availableAt).where(sql`${t.status} = 'pending'`),
    // one waiting call per key: a claimed row (attempts > 0) has started, so a newer one doesn't touch it
    uniqueIndex("logic_outbox_replace").on(t.replaceKey).where(waiting),
  ],
);

/**
 * The cron runs already ticked, so a minute ticked twice (several servers, a redelivered trigger) runs once, like
 * Solid Queue's recurring executions. Re-export it next to `outboxTable` when you have crons. Rows older than a day go.
 */
export const cronRunsTable = pgTable("logic_cron_runs", {
  /** The cron job's id, `<cron id>@<minute>`. */
  id: text("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface OutboxOptions {
  /**
   * Seconds a runner owns a delivery before a sweep may take it over. Default 300. Longer than your slowest listener;
   * with `via`, it only covers the handoff, so it's how soon a handoff that crashed is tried again.
   */
  lease?: number;
  /**
   * Hand jobs to a queue instead of running them here: `outbox(db, { via: cloudflareQueue(env.JOBS) })`. The row makes the
   * handoff durable, and the jobs of one commit go in one send. After it, the queue runs them and redelivers what throws;
   * a job that fails for good comes back here as a failed row. A send that lands but whose row isn't deleted is sent
   * again, so a job can run twice, even at once.
   */
  via?: Dispatcher;
  /**
   * Failed sends to `via` before the row is marked failed. Default 10: about 3.5 hours of backoff in all. A listener's
   * own tries are its `attempts`.
   */
  maxAttempts?: number;
  /** Seconds to wait after a failed try. Default `Math.exp(Math.min(attempt, 10))`, the curve Graphile Worker uses. */
  backoff?: (attempt: number) => number;
}

/** The outbox adapter. You call it through the registry: `registry.jobs.sweep()`, `registry.jobs.retry(id)`. */
export interface Outbox extends Dispatcher {
  /** Retries whose backoff is over and deliveries whose runner crashed (lease expired), claimed one at a time. */
  sweep(runner: Runner, options?: { limit?: number }): Promise<SweepResult>;
  /** Put a failed row back in line, with a fresh set of attempts. `false` when no failed row has that id. */
  retry(id: string): Promise<boolean>;
}

/** Anything Drizzle that can run these queries: your database, or the mutation's transaction. */
type PgClient = Pick<PgAsyncDatabase<PgQueryResultHKT>, "insert" | "update" | "delete" | "select">;

/**
 * A durable dispatcher: deliveries are rows written in the mutation's transaction, so a committed event is never lost.
 * After commit the request runs them (through `waitUntil` on serverless); `sweep` picks up what a crash or a failure
 * left behind. At least once: a crash between a listener finishing and its row being deleted runs it again.
 *
 * ```ts
 * const registry = createRegistry({ modules, database: drizzleAdapter(db), jobs: { adapter: outbox(db), scope: { store, load } } });
 * startTicking(registry); // from logic-sdk/node, or registry.jobs.sweep() from a platform's cron trigger
 * ```
 */
export function outbox(db: PgClient, options: OutboxOptions = {}): Outbox {
  const lease = options.lease ?? 300;
  const maxAttempts = options.maxAttempts ?? 10;
  const backoff = options.backoff ?? ((attempt: number) => Math.exp(Math.min(attempt, 10)));
  const t = outboxTable;
  const inSeconds = (seconds: number) => sql`now() + make_interval(secs => ${seconds})`;
  /**
   * Writes only land on rows still pending under this claim: a slow runner can't undo a newer runner's work, and a
   * handoff that finishes late can't delete the failure a consumer already recorded.
   */
  const mine = (ids: string[], attempt: number) => and(inArray(t.id, ids), eq(t.attempts, attempt), eq(t.status, "pending"));
  const via = options.via;

  const markFailed = (ids: string[], attempt: number, error: unknown) =>
    db.update(t).set({ status: "failed", lastError: messageOf(error) }).where(mine(ids, attempt));
  const backOff = (ids: string[], attempt: number, error: unknown) =>
    db.update(t).set({ availableAt: inSeconds(backoff(attempt)), lastError: messageOf(error) }).where(mine(ids, attempt));

  /**
   * Run one claimed job here and record how it went. The core decides: `failed` (its `fail` wrote the row), a throw
   * (tries left: back off), or done and discarded (delete the row).
   */
  async function run(job: Job, attempt: number, runner: Runner): Promise<keyof SweepResult> {
    let outcome: DeliveryOutcome;
    try {
      outcome = await runner.run(job, {
        attempt,
        fail: async (error) => {
          await markFailed([job.id], attempt, error);
        },
      });
    } catch (e) {
      await backOff([job.id], attempt, e);
      return "retrying";
    }
    if (outcome !== "failed") await db.delete(t).where(mine([job.id], attempt));
    return outcome;
  }

  /** Hand claimed jobs to `via` in one send. Done once the queue has them; a failed send keeps them all for a retry. */
  async function handOff(queue: Dispatcher, jobs: Job[], attempt: number, runner: Runner): Promise<keyof SweepResult> {
    const ids = jobs.map((j) => j.id);
    try {
      await queue.deliver(jobs, runner);
    } catch (e) {
      for (const job of jobs) runner.report(e, job, attempt); // the queue's failure, not the listener's: run never saw it
      if (attempt >= maxAttempts) {
        await markFailed(ids, attempt, e);
        return "failed";
      }
      await backOff(ids, attempt, e);
      return "retrying";
    }
    await db.delete(t).where(mine(ids, attempt));
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

  const settle = (job: Job, attempt: number, runner: Runner) => (via ? handOff(via, [job], attempt, runner) : run(job, attempt, runner));

  return {
    holds: true, // rows wait until they're due, however long, so `via`'s limits on delays don't apply
    replaces: true, // a waiting row is replaced in place; under `via` too, since rows wait here until they're due
    /** Must share the transaction it writes in. */
    check({ database }) {
      if (database && database.db !== db)
        throw new Error(
          "[logic-sdk] outbox(db) must use the same database as `database`: jobs are written in your mutation's transaction. " +
            "For a queue in another database, use it as `via`.",
        );
    },
    /**
     * Inside the mutation's transaction: one unclaimed row per job. Due now: leased, so a sweep leaves it to this request.
     * Delayed: available from `runAt`, for a sweep.
     */
    async enqueue(tx: unknown, jobs: Job[]) {
      const client = tx as PgClient; // SAFETY: check() refuses a database that isn't this db, so tx is its transaction
      const firstTicks = await recordTicks(client, jobs.filter((j) => j.kind === "cron"));
      const row = (j: Job) => ({
        id: j.id,
        delivery: j,
        attempts: 0,
        availableAt: j.runAt ? new Date(j.runAt) : inSeconds(lease),
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
            set: { id: sql`excluded.id`, delivery: sql`excluded.delivery`, availableAt: sql`excluded.available_at`, lastError: null },
          });
    },
    /**
     * After commit, in this request: claim the jobs that are due (one update), then run them or hand them over. A crash
     * before the claim leaves them unclaimed, so the sweep's claim is their first try.
     */
    async deliver(deliveries, runner) {
      const ids = deliveries.filter((d) => !d.runAt).map((d) => d.id);
      if (!ids.length) return;
      const claimed = await db
        .update(t)
        .set({ attempts: 1, availableAt: inSeconds(lease) }) // the lease starts now: enqueue's now() was the transaction's start
        .where(and(inArray(t.id, ids), eq(t.attempts, 0), eq(t.status, "pending")))
        .returning({ id: t.id });
      const mineNow = new Set(claimed.map((row) => row.id));
      const due = deliveries.filter((d) => mineNow.has(d.id)); // in emit order: RETURNING has none
      if (!due.length) return;
      if (via) await handOff(via, due, 1, runner);
      // one job's bookkeeping error (a lost connection) mustn't stop the others: the sweep sorts it out
      else for (const d of due) await run(d, 1, runner).catch((e) => runner.report(e, d, 1));
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
        const [row] = await db
          .update(t)
          .set({ attempts: sql`${t.attempts} + 1`, availableAt: inSeconds(lease) })
          .where(inArray(t.id, due))
          .returning({ delivery: t.delivery, attempts: t.attempts });
        if (!row) break;
        try {
          result[await settle(row.delivery, row.attempts, runner)]++;
        } catch (e) {
          runner.report(e, row.delivery, row.attempts); // its bookkeeping failed (a lost connection): its lease brings it back
        }
      }
      return result;
    },
    /** Failed rows only: a pending one belongs to its runner or a sweep, and resetting it could run it twice at once. */
    async retry(id) {
      const revived = await db
        .update(t)
        // its key goes: it has run, so it's no longer a call a newer one replaces (and one may be waiting with it)
        .set({ status: "pending", attempts: 0, availableAt: sql`now()`, lastError: null, replaceKey: null })
        .where(and(eq(t.id, id), eq(t.status, "failed")))
        .returning({ id: t.id });
      return revived.length > 0;
    },
    /** A job that failed for good in a queue consumer: keep it as a failed row, so you can query it and `retry` it. */
    async fail(job, error) {
      const lastError = messageOf(error);
      await db
        .insert(t)
        .values({ id: job.id, delivery: job, status: "failed", lastError })
        .onConflictDoUpdate({ target: t.id, set: { status: "failed", lastError } });
    },
  };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
