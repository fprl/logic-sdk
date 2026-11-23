import { drizzle } from "drizzle-orm/node-postgres";

export const testDb = drizzle("postgres://test"); // test helpers aren't module code
export const savepoint = (tx: { transaction(fn: () => Promise<void>): Promise<void> }) => tx.transaction(async () => {});
