import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../logic";

export const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/postgres";

/** One pool for the whole process. Tests use PGlite instead (test/setup.ts). */
export const db = drizzle({ client: postgres(databaseUrl) }) as unknown as Db;
