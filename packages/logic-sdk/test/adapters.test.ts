// One suite for every jobs adapter: the table in the docs ("What each one guarantees"), as tests. What only one adapter
// does (leases, receipts, pg-boss's queues) is tested next to it.
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { pgTable, text, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { fromPglite, PgBoss } from "pg-boss";
import postgres from "postgres";
import { z } from "zod";
import { cloudflareQueue, handleQueue } from "../src/cloudflare.ts";
import { databaseQueue, drizzleAdapter, jobsSchema, outbox, type DrizzleDb } from "../src/drizzle/pg.ts";
import { inProcess, init, type JobsAdapter, type FailureInfo, type Job, type Registry } from "../src/index.ts";
import { pgBoss, work, type PgBossMeta } from "../src/pg-boss.ts";

setDefaultTimeout(30_000); // pg-boss polls in real time

type Db = PgAsyncDatabase<PgQueryResultHKT>;
type Scope = { actor: string };
const { mutation, event, listener, cron, createRegistry } = init<{ scope: Scope; db: DrizzleDb<Db>; meta: PgBossMeta }>();

const orders = pgTable("adapter_orders", { tag: text("tag").notNull() });
const ran: string[] = [];
/** Tags whose listener fails, and how. */
const failing = new Map<string, "throw" | "deny">();

const placed = event({ payload: z.object({ tag: z.string() }) });
const place = mutation({
  input: z.object({ tag: z.string(), rollback: z.boolean().optional() }),
  async handler(ctx, { tag, rollback }) {
    await ctx.db.insert(orders).values({ tag });
    ctx.emit(placed, { tag });
    if (rollback) throw ctx.errors.reject("rolled_back");
  },
});
const email = listener({
  event: () => placed,
  attempts: 3,
  meta: { pgBoss: { worker: { pollingIntervalSeconds: 0.5 } } },
  async handler(ctx, { tag }) {
    ran.push(`${tag}#${ctx.event.attempt}`);
    if (failing.get(tag) === "throw") throw new Error("smtp down");
    if (failing.get(tag) === "deny") throw ctx.errors.reject("no");
  },
});
const remind = mutation({
  input: z.object({ tag: z.string() }),
  async handler(_ctx, { tag }) {
    ran.push(tag);
  },
});
const plan = mutation({
  input: z.object({ tag: z.string(), replace: z.string().optional() }),
  async handler(ctx, { tag, replace }) {
    ctx.schedule(remind, { tag }, { delay: 3600, replace });
  },
});
const tidy = mutation({
  async handler() {
    ran.push("tidy");
  },
});
const yearly = cron({ schedule: "0 9 1 1 *", run: tidy, scope: { actor: "system" } }); // only when a test ticks it
const modules = { shop: { placed, place, email, remind, plan, tidy, yearly } };

interface Guarantees {
  /** A crash right after commit doesn't lose the job. */
  kept: boolean;
  /** Tries a job with `attempts: 3` gets. */
  tries: number;
  /** A job that failed for good is there to `retry(id)`. */
  keepsFailed: boolean;
  holds: boolean;
  replaces: boolean;
  /** Runs of a cron whose minute was ticked twice. */
  ticks: number;
}

interface Running {
  db: Db;
  adapter: JobsAdapter;
  /** A consumer, or pg-boss's worker, where the adapter needs one. */
  start?(registry: Registry<Scope>): Promise<void>;
  /** Time passes, and everything runs: delays, backoffs, redeliveries. */
  settle(registry: Registry<Scope>): Promise<void>;
  close(): Promise<void>;
}

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
  return { db, close, adapter: databaseQueue(drizzleAdapter(db)), settle: (registry) => sweepAll(db, registry) };
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
    adapter: outbox(drizzleAdapter(db), cloudflareQueue(queue)),
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
    start: (registry) => work(registry, boss, { calls: { worker: { pollingIntervalSeconds: 0.5 } }, crons: { worker: { pollingIntervalSeconds: 0.5 } } }),
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
  ["inProcess", openInProcess, { kept: false, tries: 1, keepsFailed: false, holds: false, replaces: false, ticks: 2 }],
  ["databaseQueue", openDatabaseQueue, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1 }],
  ["cloudflareQueue", openCloudflare, { kept: false, tries: 3, keepsFailed: false, holds: true, replaces: false, ticks: 2 }],
  ["outbox in front of cloudflareQueue", openOutbox, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1 }],
  ["pgBoss", openPgBoss, { kept: true, tries: 3, keepsFailed: true, holds: true, replaces: true, ticks: 1 }],
];
const url = process.env.DATABASE_URL;
const databases: [string, string | undefined][] = [["PGlite", undefined], ...(url ? [["Postgres", url] satisfies [string, string]] : [])];

for (const [database, at] of databases)
  for (const [name, open, guarantees] of adapters)
    describe(`${name} on ${database}`, () => {
      let running: Running;
      let registry: Registry<Scope, typeof modules>;
      let app: ReturnType<typeof registry.as>;
      const failures: FailureInfo[] = [];
      const build = (adapter: JobsAdapter) =>
        createRegistry({
          modules,
          database: drizzleAdapter(running.db),
          jobs: { adapter, scope: { load: (saved) => saved } },
          onError: (_error, info) => failures.push(info),
        });
      const tag = () => crypto.randomUUID();
      const runsOf = (what: string) => ran.filter((run) => run.startsWith(what));
      const settle = () => running.settle(registry);

      beforeAll(async () => {
        running = await open(at);
        registry = build(running.adapter);
        app = registry.as({ actor: "ana" });
        await running.start?.(registry);
      });
      afterAll(() => running.close());

      test("a commit's job runs once; a rollback leaves none", async () => {
        const [ok, undone] = [tag(), tag()];
        await app.run(place, { tag: ok });
        await expect(app.run(place, { tag: undone, rollback: true })).rejects.toMatchObject({ kind: "rejected" });
        await settle();
        expect(runsOf(ok)).toEqual([`${ok}#1`]);
        expect(runsOf(undone)).toEqual([]);
      });

      test(guarantees.kept ? "a crash right after commit doesn't lose the job" : "a crash right after commit loses the job", async () => {
        const crashed = tag();
        const died = build({ ...running.adapter, deliver: async () => {} }); // the process died before it ran or sent
        await died.as({ actor: "ana" }).run(place, { tag: crashed });
        await settle();
        expect(runsOf(crashed)).toEqual(guarantees.kept ? [`${crashed}#1`] : []);
      });

      test("a throw gets its tries, then it's failed", async () => {
        const broken = tag();
        failing.set(broken, "throw");
        await app.run(place, { tag: broken });
        await settle();
        expect(runsOf(broken)).toEqual(Array.from({ length: guarantees.tries }, (_, i) => `${broken}#${i + 1}`));
        const outcomes = failures.filter((f) => f.job?.kind === "delivery" && JSON.stringify(f.job.envelope.payload).includes(broken)).map((f) => f.outcome);
        expect(outcomes).toEqual([...Array.from({ length: guarantees.tries - 1 }, () => "retry" as const), "failed"]);
      });

      test("a rule saying no is failed at once", async () => {
        const denied = tag();
        failing.set(denied, "deny");
        await app.run(place, { tag: denied });
        await settle();
        expect(runsOf(denied)).toEqual([`${denied}#1`]);
      });

      test(guarantees.keepsFailed ? "retry(id) runs a failed job again, as a first try" : "nothing keeps a failed job, so retry(id) refuses", async () => {
        const fixed = tag();
        failing.set(fixed, "deny");
        await app.run(place, { tag: fixed });
        await settle();
        const id = failures.findLast((f) => f.outcome === "failed")?.job?.id ?? "";
        if (!guarantees.keepsFailed) {
          await expect(registry.jobs.retry(id)).rejects.toThrow(/keeps no jobs/);
          return;
        }
        failing.delete(fixed);
        expect(await registry.jobs.retry(id)).toBe(true);
        await settle();
        expect(runsOf(fixed)).toEqual([`${fixed}#1`, `${fixed}#1`]);
      });

      test(guarantees.holds ? "a scheduled call waits, then runs" : "a scheduled call that waits is refused", async () => {
        const later = tag();
        if (!guarantees.holds) {
          await expect(app.run(plan, { tag: later })).rejects.toThrow(/can't hold jobs/);
          return;
        }
        await app.run(plan, { tag: later });
        expect(runsOf(later)).toEqual([]);
        await settle();
        expect(runsOf(later)).toEqual([later]);
      });

      test(guarantees.replaces ? "replace keeps only the newer call" : "replace is refused", async () => {
        const [first, newer, key] = [tag(), tag(), tag()];
        if (!guarantees.replaces) {
          await expect(app.run(plan, { tag: first, replace: key })).rejects.toThrow(/can't replace/);
          return;
        }
        await app.run(plan, { tag: first, replace: key });
        await app.run(plan, { tag: newer, replace: key });
        await settle();
        expect(runsOf(first)).toEqual([]);
        expect(runsOf(newer)).toEqual([newer]);
      });

      test(`a cron's minute ticked twice runs ${guarantees.ticks === 1 ? "once" : "twice"}`, async () => {
        // a year of its own: pg-boss remembers a minute for 7 days
        const minute = new Date(Date.UTC(3000 + Math.floor(Math.random() * 6000), 0, 1, 9));
        const before = runsOf("tidy").length;
        await registry.jobs.tick(minute);
        await registry.jobs.tick(minute);
        await settle();
        expect(runsOf("tidy").length - before).toBe(guarantees.ticks);
      });
    });
