import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, test } from "bun:test";
import { z } from "zod";
import { databaseQueue, drizzleAdapter, jobsSchema, jobsTable, type DrizzleTx } from "../src/drizzle/pg.ts";
import { init } from "../src/index.ts";

// PGlite runs one connection at a time, so only real Postgres can show two sweepers racing (CI sets DATABASE_URL).
const url = process.env.DATABASE_URL ?? "";

test.skipIf(!url)("sweepers on separate connections at once: every job runs exactly once", async () => {
  // a schema of its own, so whatever database DATABASE_URL names keeps its own logic_jobs
  const schema = `logic_sdk_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const client = postgres(url, { max: 10, onnotice: () => {}, connection: {
    search_path: schema,
    // plans that run a claim's subquery once per row, where `id IN (... LIMIT 1 ...)` claims many rows and runs one
    enable_hashjoin: "off",
    enable_mergejoin: "off",
    enable_hashagg: "off",
    enable_sort: "off",
    enable_material: "off",
  } });
  try {
    const db = drizzle({ client });
    const database = drizzleAdapter(db);
    await client.unsafe(jobsSchema);

    const { event, listener, createRegistry } = init<{ scope: object; db: DrizzleTx<typeof db> }>();
    const happened = event({ payload: z.object({ n: z.number() }) });
    const runs = new Map<number, number>();
    const count = listener({
      event: () => happened,
      async handler(_ctx, { n }) {
        runs.set(n, (runs.get(n) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 5)); // hold the row a little, so sweepers overlap
      },
    });
    const registry = createRegistry({ modules: { x: { happened, count } }, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });

    const jobs = Array.from({ length: 60 }, (_, n) => {
      const envelope = { id: `e${n}`, name: "x.happened", payload: { n }, scope: {}, occurredAt: new Date().toISOString(), depth: 1 };
      return { id: `x.count@e${n}`, job: { kind: "delivery" as const, id: `x.count@e${n}`, listener: "x.count", envelope, attempts: 1 } };
    });
    await db.insert(jobsTable).values(jobs); // due now, unclaimed
    await db.execute(sql`ANALYZE logic_jobs`);

    const results = await Promise.all(Array.from({ length: 6 }, () => registry.jobs.sweep()));

    expect(results.reduce((sum, r) => sum + r.done, 0)).toBe(60);
    expect(runs.size).toBe(60);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  } finally {
    await client.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
