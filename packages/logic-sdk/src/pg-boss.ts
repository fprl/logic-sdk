/// <reference types="node" />
// pg-boss runs on Node (`pg`, `node:events`), so this subpath may too; the core stays runtime-neutral.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromDrizzle, type Db, type DrizzleTransactionLike, type JobInsert, type JobResult, type PgBoss, type Queue, type WorkOptions } from "pg-boss";
import type { DatabaseAdapter, Dispatcher, Job, Jobs, Registry } from "./index.ts";
import { startTicking } from "./node.ts";

/**
 * What this adapter reads from a listener's `meta`: `init<{ meta: PgBossMeta & AppMeta }>()`, then
 * `meta: { pgBoss: { queue: { expireInSeconds: 120 }, worker: { localConcurrency: 5 } } }`. Tuning only: retries are the
 * listener's `attempts`, and the other adapters ignore it.
 */
export type PgBossMeta = {
  pgBoss?: {
    /** The listener's queue (`expireInSeconds`, `retryDelay`, `deadLetter`…), applied by `work()`. `partition` only when it's created. */
    queue?: Omit<Queue, "name" | "retryLimit" | "retryBackoff" | "policy">;
    /** Its workers in each process that calls `work()`: `localConcurrency`, `batchSize`, `pollingIntervalSeconds`… */
    worker?: Omit<WorkOptions, "includeMetadata" | "perJobResults" | "transactional" | "transactionTimeoutSeconds">;
  };
};
type Tuning = NonNullable<PgBossMeta["pgBoss"]>;

/** Where scheduled calls (`ctx.schedule`) wait: one queue for all of them, so no function needs a worker of its own. */
export const CALLS_QUEUE = "logic-sdk.calls";

/** A job's queue: its listener's or its cron's, named by the id, or the shared one for scheduled calls. */
const queueOf = (job: Job) => (job.kind === "delivery" ? job.listener : job.kind === "cron" ? job.cron : CALLS_QUEUE);

/** A queue as `meta.pgBoss.queue` tunes it. Backoff on, as on every job we insert, which `retryDelayMax` needs. */
const queueConfig = (queue: Tuning["queue"]) => ({ ...queue, retryBackoff: true });

/** `meta.pgBoss` as `PgBossMeta` types it where you write it (meta is stored loose). */
const tuningOf = (meta: Readonly<Record<string, unknown>> | undefined) => meta?.pgBoss as Tuning | undefined;

// A UUID of our own, so the v5 ids below can't collide with anyone else's.
const NAMESPACE = Buffer.from("408a95afcd954c069af0d15cb1dfc0db", "hex");

/**
 * The pg-boss id of a job: a UUID v5 of its logic-sdk id (pg-boss ids are UUIDs). The same job is the same row, so a
 * minute ticked by several servers inserts once. Use it to find a job in pg-boss: `boss.findJobs(queue, { id: pgBossId(id) })`.
 */
export function pgBossId(id: string): string {
  const hash = createHash("sha1").update(NAMESPACE).update(id).digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = hash.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A job as a pg-boss row. Its tries are stamped here, as pg-boss counts them: retries after the first. */
const rowOf = (job: Job, replaceKey?: string): JobInsert<Job> => ({
  id: pgBossId(job.id),
  data: job,
  startAfter: job.runAt,
  retryLimit: job.attempts - 1,
  retryBackoff: true, // pg-boss retries at once by default; this waits 1 to 2 s, then 2 to 4 s, 4 to 8 s…
  singletonKey: replaceKey,
});

/** Why a job failed for good, from the adapter's `fail` to `work()`'s result for it: the same job object passes through both. */
const reasons = new WeakMap<Job, unknown>();

// SAFETY: `check` requires a database adapter, and its transactions are Drizzle's (`drizzleAdapter`), which `execute` SQL
const inTx = (tx: unknown): Db => fromDrizzle(tx as DrizzleTransactionLike, sql);

/**
 * Jobs in pg-boss, inserted in your mutation's transaction, so a rollback leaves none and a commit always has them,
 * like Oban. Run them with `work(registry, boss)` in a worker process. Every process that enqueues calls
 * `await boss.start()` first.
 *
 * ```ts
 * const boss = new PgBoss(process.env.DATABASE_URL!);
 * boss.on("error", console.error);
 * const registry = createRegistry({ modules, database: drizzleAdapter(db), jobs: { adapter: pgBoss(boss), scope: { store, load } } });
 * ```
 */
export function pgBoss(boss: PgBoss): Dispatcher {
  let database: DatabaseAdapter<unknown, unknown> | undefined;
  const queueOptions = new Map<string, Tuning["queue"]>();

  /**
   * pg-boss needs a job's queue to exist, and `work()` creates them all; this covers a process that enqueues first (a
   * new listener, deployed before its worker). The miss is pg-boss's cache, before any SQL, so the transaction is fine.
   */
  async function inQueue(name: string, write: () => Promise<unknown>) {
    try {
      await write();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "PGBOSS_QUEUE_NOT_FOUND")) throw error;
      await boss.createQueue(name, queueConfig(queueOptions.get(name)));
      await write();
    }
  }

  /**
   * The waiting calls with these keys go, inside the transaction, so the new ones take their place. Only `created` ones:
   * a job in `retry` has started, and isn't touched.
   */
  async function replaceWaiting(db: Db, keys: string[]) {
    // in key order, so two transactions replacing the same keys lock them in the same order and can't deadlock
    for (const key of [...new Set(keys)].sort()) {
      // one replacer per key at a time, so the second sees the first's call and replaces it (the outbox's unique index)
      await db.executeSql("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`logic-sdk.replace:${key}`]);
      // a no-op edit that locks the key's queued jobs: a worker's fetch skips locked rows, so none starts while we look
      const { jobs: locked } = await boss.update(CALLS_QUEUE, undefined, { singletonKey: key, match: "all", db });
      if (!locked.length) continue;
      const queued = await boss.findJobs<Job>(CALLS_QUEUE, { key, queued: true, db });
      const waiting = queued.filter((j) => j.state === "created" && locked.includes(j.id)).map((j) => j.id);
      if (waiting.length) await boss.deleteJob(CALLS_QUEUE, waiting, { db });
    }
  }

  return {
    holds: true, // `startAfter`, however far ahead
    replaces: true,
    /** pg-boss inserts in the mutation's transaction, through it. */
    check({ listeners, database: given }) {
      if (!given) throw new Error("[logic-sdk] pgBoss(boss) needs `database`: jobs are inserted in your mutation's transaction.");
      database = given;
      for (const l of listeners) queueOptions.set(l.id, tuningOf(l.listener.meta)?.queue);
    },
    /** Inside the mutation's transaction: one insert per queue. pg-boss skips a row whose id it already has. */
    async enqueue(tx, jobs) {
      const db = inTx(tx);
      const keyOf = (job: Job) => (job.kind === "call" && job.replace !== undefined ? `${job.fn}@${job.replace}` : undefined);
      for (const [name, list] of Map.groupBy(jobs, queueOf)) {
        const keys = list.map(keyOf).filter((key) => key !== undefined);
        await inQueue(name, async () => {
          if (keys.length) await replaceWaiting(db, keys);
          await boss.insert(name, list.map((job) => rowOf(job, keyOf(job))), { db });
        });
      }
    },
    /** pg-boss's workers pick jobs up (`work()`), so there's nothing to do after commit. */
    async deliver() {},
    /** `registry.jobs.run` calls it in `work()` when a job fails for good: the error becomes the job's pg-boss `output`. */
    async fail(job, error) {
      reasons.set(job, error);
    },
    /**
     * A failed job, back in line with a fresh set of attempts (pg-boss's own `retry` gives one more). Its replace key goes:
     * it has run, so it's no longer a call a newer one replaces.
     */
    async retry(id) {
      // its queue: the listener's or cron's (the id's prefix), or the calls queue. Looked up first: inside the
      // transaction, a lookup on pg-boss's own connection would wait for it on PGlite.
      const prefix = id.slice(0, id.lastIndexOf("@"));
      const names = [prefix, CALLS_QUEUE].filter((name) => /^[\w.\-/]+$/.test(name)); // pg-boss's queue names
      const queues = await boss.getQueues(names);
      if (!database || !queues.length) return false;
      const uuid = pgBossId(id);
      return database.transaction(async (tx) => {
        const db = inTx(tx);
        for (const { name } of queues) {
          // failed to retry, under the row's lock: one retry(id) gets it, and no worker starts it until it's reset below
          const { affected } = await boss.retry(name, uuid, { db });
          if (!affected) continue;
          const [failed] = await boss.findJobs<Job>(name, { id: uuid, db });
          if (!failed) continue;
          // as new: retry count 0, `attempts - 1` retries
          await boss.deleteJob(name, uuid, { db });
          await boss.insert(name, [rowOf(failed.data)], { db });
          return true;
        }
        return false;
      });
    },
  };
}

export interface PgBossWorkOptions {
  /** The shared queue of scheduled calls, tuned like a listener's `meta.pgBoss`: `{ worker: { localConcurrency: 10 } }`. */
  calls?: Tuning;
  /** Where a failed cron tick goes. Default `console.error`. */
  onError?: (error: unknown) => void;
}

/**
 * Your worker process: a queue and its workers for every listener and cron, one for scheduled calls, and the cron tick
 * every minute. `boss.stop()` stops all of it. Applies each listener's `meta.pgBoss`.
 *
 * ```ts
 * await boss.start();
 * await work(registry, boss);
 * process.on("SIGTERM", () => boss.stop()); // waits for running jobs, 30 s at most
 * ```
 */
export async function work(
  registry: Pick<Registry, "definitions"> & { jobs: Pick<Jobs, "run" | "tick" | "sweep"> },
  boss: PgBoss,
  options: PgBossWorkOptions = {},
): Promise<void> {
  const { listeners, crons } = registry.definitions;
  const queues: [string, Tuning | undefined][] = [
    ...listeners.map((l): [string, Tuning | undefined] => [l.id, tuningOf(l.listener.meta)]),
    ...crons.map((c): [string, Tuning | undefined] => [c.id, undefined]),
    [CALLS_QUEUE, options.calls],
  ];

  /** One job's try. `failed` is over (out of tries, or retrying can't help), so pg-boss mustn't retry it. */
  const settle = async (job: { id: string; data: Job; retryCount: number }): Promise<JobResult> => {
    try {
      const outcome = await registry.jobs.run(job.data, { attempt: job.retryCount + 1 });
      if (outcome === "failed") return { id: job.id, status: "deadletter", output: reasons.get(job.data) };
      return { id: job.id, status: "completed" };
    } catch (error) {
      return { id: job.id, status: "failed", output: error }; // reported already; pg-boss retries it after a backoff
    }
  };

  for (const [name, tuning] of queues) {
    const { partition, ...queue } = queueConfig(tuning?.queue);
    await boss.createQueue(name, { ...queue, partition }); // a no-op when it exists, so its options are updated below
    await boss.updateQueue(name, queue);
    await boss.work<Job>(name, { ...tuning?.worker, perJobResults: true }, (jobs) => Promise.all(jobs.map(settle)));
  }

  if (!crons.length) return;
  // ticked by every worker: the minute's job id is the same everywhere, so pg-boss inserts one row
  const stop = startTicking(registry, { sweepEvery: 0, onError: options.onError });
  boss.once("stopped", () => void stop());
}
