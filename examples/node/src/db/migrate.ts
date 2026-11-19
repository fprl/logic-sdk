import { readFileSync } from "node:fs";
import postgres from "postgres";
import { databaseUrl } from "./client";

const sql = postgres(databaseUrl);
await sql.unsafe(readFileSync(new URL("./migrate.sql", import.meta.url), "utf8"));
await sql.end();
console.log("migrated");
