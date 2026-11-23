import type { Db } from "../db";
import { attempt } from "../lib/savepoint";
import { connect } from "../db";

export async function restock(db: Db) {
  await db.transaction(async () => {});
  await attempt(db);
  return connect;
}
