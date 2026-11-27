// The jobs adapters suite (conformance/jobs-adapters.suite.ts) on every adapter, on PGlite and on Postgres when DATABASE_URL is set.
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { setDefaultTimeout } from "bun:test";
import postgres from "postgres";
import { cloudflareQueue, handleQueue } from "../../src/cloudflare.ts";
import { databaseQueue, jobsSchema, outbox } from "../../src/drizzle/pg.ts";
import { inProcess, type Job, type Registry } from "../../src/index.ts";
import { work } from "../../src/node.ts";
import { jobsAdapterSuite, type Db, type Guarantees, type Running, type Scope } from "../conformance/jobs-adapters.suite.ts";

setDefaultTimeout(30_000); // the workers poll in real time

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
    await db.execute(sql`UPDATE logic_jobs SET available_at = now() - interval '1 day' WHERE status = 'pending'`); // past the grace an outbox's sweep gives a signal
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
    // the consumer first, so keyed jobs run from their signals; then the sweep, and the consumer again for what it sent
    async settle(registry) {
      do {
        while (queue.size) await queue.deliverAll(registry);
        await sweepAll(db, registry);
      } while (queue.size);
    },
  };
}

/** `databaseQueue({ runIn: "worker" })`: web requests only write rows, and `work()` runs them, until none are pending. */
async function openWorker(url?: string): Promise<Running> {
  const { db, close } = await openDatabase(url);
  return {
    db,
    close,
    adapter: databaseQueue({ runIn: "worker" }),
    async settle(registry) {
      const stop = work(registry, { concurrency: 3, pollEvery: 0.01 });
      for (let i = 0; i < 500; i++) {
        const pending = await db.select({ id: sql`id` }).from(sql`logic_jobs`).where(sql`status = 'pending'`);
        if (!pending.length) return stop();
        // time passes for what waits (a delay, a backoff), not for what runs
        await db.execute(sql`UPDATE logic_jobs SET available_at = now() - interval '1 second' WHERE status = 'pending' AND claimed_at IS NULL`);
        await sleep(10);
      }
      await stop();
      throw new Error("the workers never emptied the table");
    },
  };
}

const adapters: [string, (url?: string) => Promise<Running>, Guarantees][] = [
  ["inProcess", openInProcess, { kept: false, tries: 1, keepsFailed: false, holds: false, replaces: false, ticks: 2, lists: false, orders: true }],
  ["databaseQueue", openDatabaseQueue, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1, lists: true, orders: true }],
  ["cloudflareQueue", openCloudflare, { kept: false, tries: 3, keepsFailed: false, holds: true, replaces: false, ticks: 2, lists: false, orders: false }],
  ["outbox in front of cloudflareQueue", openOutbox, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1, lists: true, orders: true }],
  ["databaseQueue with workers", openWorker, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1, lists: true, orders: true }],
];
const url = process.env.DATABASE_URL;
const databases: [string, string | undefined][] = [["PGlite", undefined], ...(url ? [["Postgres", url] satisfies [string, string]] : [])];

for (const [database, at] of databases)
  for (const [name, open, guarantees] of adapters) jobsAdapterSuite(`${name} on ${database}`, () => open(at), guarantees);
