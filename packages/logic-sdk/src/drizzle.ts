import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { DatabaseAdapter, Delivery, DeliveryOutcome, Dispatcher, RunDelivery, SweepResult } from "./index.ts";

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
 * Use a Drizzle database for mutations. Needs a driver with interactive transactions
 * (node-postgres, postgres.js, PGlite, Neon websocket, Hyperdrive, better-sqlite3, libsql...).
 * Not D1 or HTTP drivers.
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

/**
 * The outbox table (Postgres). Re-export it from your schema so drizzle-kit adds it to your migrations:
 * `export { outboxTable } from "logic-sdk/drizzle";`. One row per pending delivery; done rows are deleted,
 * failed ones stay so you can query them and `retry` them.
 */
export const outboxTable = pgTable(
  "logic_outbox",
  {
    /** The delivery id, `<event id>:<listener id>`. */
    id: text("id").primaryKey(),
    delivery: jsonb("delivery").$type<Delivery>().notNull(),
    /** `failed`: out of attempts, or a rule said no. Retrying is your call (`registry.jobs.retry(id)`). */
    status: text("status").$type<"pending" | "failed">().notNull().default("pending"),
    /** Incremented when a runner claims it, so a crash still uses an attempt. */
    attempts: integer("attempts").notNull().default(0),
    /** Due from then on. While claimed: when the lease ends and a sweep may take it over. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("logic_outbox_due").on(t.availableAt).where(sql`${t.status} = 'pending'`)],
);

export interface OutboxOptions {
  /** Seconds a runner owns a delivery before a sweep may take it over. Longer than your slowest listener. Default 300. */
  lease?: number;
  /** Tries before a delivery is marked failed. Default 10: about 3.5 hours of backoff in all. */
  maxAttempts?: number;
  /** Seconds to wait after a failed try. Default `Math.exp(Math.min(attempt, 10))`, the curve Graphile Worker uses. */
  backoff?: (attempt: number) => number;
}

/** The outbox transport. You call it through the registry: `registry.jobs.sweep()`, `registry.jobs.retry(id)`. */
export interface Outbox extends Dispatcher {
  /** Retries whose backoff is over and deliveries whose runner crashed (lease expired), claimed one at a time. */
  sweep(run: RunDelivery, options?: { limit?: number }): Promise<SweepResult>;
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
 * const registry = createRegistry({ modules, database: drizzleAdapter(db), jobs: outbox(db) });
 * setInterval(() => registry.jobs.sweep(), 60_000); // or a cron
 * ```
 */
export function outbox(db: PgClient, options: OutboxOptions = {}): Outbox {
  const lease = options.lease ?? 300;
  const maxAttempts = options.maxAttempts ?? 10;
  const backoff = options.backoff ?? ((attempt: number) => Math.exp(Math.min(attempt, 10)));
  const t = outboxTable;
  const inSeconds = (seconds: number) => sql`now() + make_interval(secs => ${seconds})`;
  /** Writes only land if no one has claimed the row since: a slow listener can't undo a newer runner's work. */
  const mine = (id: string, attempt: number) => and(eq(t.id, id), eq(t.attempts, attempt));

  /** Run one claimed delivery and record how it went. */
  async function settle(delivery: Delivery, attempt: number, run: RunDelivery): Promise<keyof SweepResult> {
    let outcome: DeliveryOutcome;
    try {
      outcome = await run(delivery, { attempt });
    } catch (e) {
      const lastError = e instanceof Error ? e.message : String(e);
      if (attempt >= maxAttempts) {
        await db.update(t).set({ status: "failed", lastError }).where(mine(delivery.id, attempt));
        return "failed";
      }
      await db.update(t).set({ availableAt: inSeconds(backoff(attempt)), lastError }).where(mine(delivery.id, attempt));
      return "retrying";
    }
    if (outcome === "done") {
      await db.delete(t).where(mine(delivery.id, attempt));
      return "done";
    }
    await db.update(t).set({ status: "failed", lastError: "failed for good (reported to onError)" }).where(mine(delivery.id, attempt));
    return "failed";
  }

  return {
    /** Inside the mutation's transaction: one row per delivery, already claimed by this request for its first try. */
    async enqueue(tx: unknown, deliveries: Delivery[]) {
      await (tx as PgClient).insert(t).values(deliveries.map((d) => ({ id: d.id, delivery: d, attempts: 1, availableAt: inSeconds(lease) })));
    },
    /** After commit, in this request: the first try of each. */
    async deliver(deliveries: Delivery[], run: RunDelivery) {
      for (const d of deliveries) await settle(d, 1, run);
    },
    async sweep(run, { limit = 100 } = {}) {
      const result: SweepResult = { done: 0, failed: 0, retrying: 0 };
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
        result[await settle(row.delivery, row.attempts, run)]++;
      }
      return result;
    },
    /** Failed rows only: a pending one belongs to its runner or a sweep, and resetting it could run it twice at once. */
    async retry(id) {
      const revived = await db
        .update(t)
        .set({ status: "pending", attempts: 0, availableAt: sql`now()`, lastError: null })
        .where(and(eq(t.id, id), eq(t.status, "failed")))
        .returning({ id: t.id });
      return revived.length > 0;
    },
  };
}
