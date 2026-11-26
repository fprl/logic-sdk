// The jobs adapters suite (conformance/jobs-adapters.suite.ts) on every adapter, on PGlite and on Postgres when DATABASE_URL is set.
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { setDefaultTimeout } from "bun:test";
import { fromPglite, PgBoss } from "pg-boss";
import postgres from "postgres";
import { cloudflareQueue, handleQueue } from "../../src/cloudflare.ts";
import { databaseQueue, jobsSchema, outbox } from "../../src/drizzle/pg.ts";
import { inProcess, type Job, type Registry } from "../../src/index.ts";
import { pgBoss, work } from "../../src/pg-boss.ts";
import { jobsAdapterSuite, type Db, type Guarantees, type Running, type Scope } from "../conformance/jobs-adapters.suite.ts";

setDefaultTimeout(30_000); // pg-boss polls in real time

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The tables on one connection. Temporary on a real Postgres, so whatever database DATABASE_URL names keeps its own. */
async function openDatabase(url?: string) {
  const pglite = url ? undefined : new PGlite();
  const client = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
  const db: Db = client ? drizzlePostgres({ client }) : drizzlePglite({ client: pglite! });
  const tables = `${jobsSchema} CREATE TABLE adapter_orders (tag text NOT NULL);`;
  if (client) await client.unsafe(tables.replaceAll("CREATE TABLE", "CREATE TEMP TABLE"));
  else await pglite!.exec(tables);
  return { db, pglite, close: async () => void (await (client ? client.end() : pglite!.close())) };
}

/** A queue that follows Cloudflare's documented rules: one message per batch, redelivered up to `max_retries`. */
function fakeCloudflare() {
  let waiting: { body: Job; attempts: number }[] = [];
  return {
    get size() {
      return waiting.length;
    },
    async sendBatch(messages: Iterable<{ body: Job }>) {
      for (const { body } of messages) waiting.push({ body: structuredClone(body), attempts: 1 });
    },
    async deliverAll(registry: Registry<Scope>) {
      const now = waiting;
      waiting = [];
      for (const { body, attempts } of now) {
        const retry = () => {
          if (attempts <= 10) waiting.push({ body, attempts: attempts + 1 }); // max_retries: 10
        };
        await handleQueue(registry, { messages: [{ body, attempts, ack: () => {}, retry }] });
      }
    },
  };
}

/** Make the table's jobs due and sweep, until none are pending. */
async function sweepAll(db: Db, registry: Registry<Scope>) {
  for (let i = 0; i < 10; i++) {
    await db.execute(sql`UPDATE logic_jobs SET available_at = now() - interval '1 second' WHERE status = 'pending'`);
    const { done, failed, discarded, retrying } = await registry.jobs.sweep();
    if (done + failed + discarded + retrying === 0) return;
  }
  throw new Error("the table never settled");
}

async function openInProcess(url?: string): Promise<Running> {
  const { db, close } = await openDatabase(url);
  return { db, close, adapter: inProcess(), settle: async () => {} };
}

async function openDatabaseQueue(url?: string): Promise<Running> {
  const { db, close } = await openDatabase(url);
  return { db, close, adapter: databaseQueue(), settle: (registry) => sweepAll(db, registry) };
}

async function openCloudflare(url?: string): Promise<Running> {
  const { db, close } = await openDatabase(url);
  const queue = fakeCloudflare();
  return {
    db,
    close,
    adapter: cloudflareQueue(queue),
    async settle(registry) {
      while (queue.size) await queue.deliverAll(registry);
    },
  };
}

async function openOutbox(url?: string): Promise<Running> {
  const { db, close } = await openDatabase(url);
  const queue = fakeCloudflare();
  return {
    db,
    close,
    adapter: outbox(cloudflareQueue(queue)),
    async settle(registry) {
      await sweepAll(db, registry);
      while (queue.size) await queue.deliverAll(registry);
    },
  };
}

async function openPgBoss(url?: string): Promise<Running> {
  const { db, pglite, close } = await openDatabase(url);
  // pg-boss can't live in temporary tables: on a real Postgres it keeps one schema of its own, the same on every run
  const schema = url ? "logic_sdk_adapters" : "pgboss";
  const boss = url ? new PgBoss({ connectionString: url, schema, max: 3 }) : new PgBoss({ db: fromPglite(pglite!), backend: "pglite" });
  boss.on("error", console.error);
  await boss.start();
  const jobs = sql.raw(`${schema}.job`);
  return {
    db,
    adapter: pgBoss(boss),
    start: (registry) => work(registry, boss, { calls: { worker: { pollingIntervalSeconds: 0.5 } } }),
    async settle() {
      const end = performance.now() + 15_000;
      while (performance.now() < end) {
        await db.execute(sql`UPDATE ${jobs} SET start_after = now() WHERE name LIKE 'logic-sdk.%' AND state IN ('created', 'retry') AND start_after > now()`);
        const open = await db.select({ name: sql<string>`name` }).from(jobs).where(sql`name LIKE 'logic-sdk.%' AND state IN ('created', 'retry', 'active')`);
        if (!open.length) return;
        await sleep(100);
      }
      throw new Error("pg-boss never settled");
    },
    async close() {
      await boss.stop({ graceful: false });
      await close();
    },
  };
}

const adapters: [string, (url?: string) => Promise<Running>, Guarantees][] = [
  ["inProcess", openInProcess, { kept: false, tries: 1, keepsFailed: false, holds: false, replaces: false, ticks: 2, lists: false }],
  ["databaseQueue", openDatabaseQueue, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1, lists: true }],
  ["cloudflareQueue", openCloudflare, { kept: false, tries: 3, keepsFailed: false, holds: true, replaces: false, ticks: 2, lists: false }],
  ["outbox in front of cloudflareQueue", openOutbox, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1, lists: true }],
  // pg-boss keeps them (retry, forget), but lists them per queue only: boss.findJobs
  ["pgBoss", openPgBoss, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1, lists: false }],
];
const url = process.env.DATABASE_URL;
const databases: [string, string | undefined][] = [["PGlite", undefined], ...(url ? [["Postgres", url] satisfies [string, string]] : [])];

for (const [database, at] of databases)
  for (const [name, open, guarantees] of adapters) jobsAdapterSuite(`${name} on ${database}`, () => open(at), guarantees);
