import type { DatabaseAdapter } from "./index.ts";

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
