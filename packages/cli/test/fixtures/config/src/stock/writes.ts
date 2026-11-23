import type { Db } from "../db";
import { attempt } from "../lib/savepoint";
import { connect } from "../db";
import * as pg from "drizzle-orm/node-postgres";

export async function restock(db: Db, ledger: { transaction(id: string): void }) {
  await db.transaction(async () => {});
  await attempt(db);
  await (db as any)["transaction"](async () => {});
  ledger.transaction("txn_1"); // a payments service's own method: not a database
  return [connect, pg.drizzle("postgres://x")];
}
