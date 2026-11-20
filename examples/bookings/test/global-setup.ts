import postgres from "postgres";
import { migration } from "./setup";

/** Real Postgres only: migrate once per run, before test files start in parallel. */
export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = postgres(url, { onnotice: () => {} });
  await sql.unsafe(migration);
  await sql.end();
}
