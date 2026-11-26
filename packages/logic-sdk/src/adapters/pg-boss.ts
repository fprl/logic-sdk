/// <reference types="node" />
// pg-boss runs on Node (`pg`, `node:events`), so this subpath may too; the core stays runtime-neutral.
import { createHash } from "node:crypto";
import { type Db, type JobInsert, type PgBoss, type Queue, type WorkOptions } from "pg-boss";
import { storedReplaceKey } from "../core/jobs.ts";
import type { ForListeners, SqlDatabase, Job, JobsAdapter } from "../core/types.ts";

/** One queue's tuning: a listener's or cron's `meta.pgBoss`, and `work()`'s `calls`. */
export interface PgBossTuning {
  /** The listener's queue (`expireInSeconds`, `retryDelay`, `deadLetter`…), applied by `work()`. `partition` only when it's created. */
  queue?: Omit<Queue, "name" | "retryLimit" | "retryBackoff" | "policy">;
  /** Its workers in each process that calls `work()`: `localConcurrency`, `batchSize`, `pollingIntervalSeconds`… */
  worker?: Omit<WorkOptions, "includeMetadata" | "perJobResults" | "transactional" | "transactionTimeoutSeconds">;
}

/**
 * What this adapter reads from a listener's or cron's `meta` (not a function's): `init<{ meta: PgBossMeta & AppMeta }>()`, then
 * `meta: { pgBoss: { queue: { expireInSeconds: 120 }, worker: { localConcurrency: 5 } } }`. Tuning only: retries are the
 * listener's `attempts`, and the other adapters ignore it.
 */
export type PgBossMeta = ForListeners<{ pgBoss?: PgBossTuning }>;

/** Our queues' names start with it, so they can't collide with your own pg-boss queues, and `work()` can find ours. */
export const PREFIX = "logic-sdk.";
/** A listener's or cron's queue: `logic-sdk.notifications.send`. */
export const queueName = (id: string) => `${PREFIX}${id}`;
/** Where scheduled calls (`ctx.schedule`) wait: one queue for all of them, so no function needs a worker of its own. */
export const CALLS_QUEUE = `${PREFIX}calls`; // ids always have a dot, so no listener's queue is this one

/** A job's queue: its listener's or its cron's, or the shared one for scheduled calls. */
const queueOf = (job: Job) => (job.kind === "delivery" ? queueName(job.listener) : job.kind === "cron" ? queueName(job.cron) : CALLS_QUEUE);

/** A queue as `meta.pgBoss.queue` tunes it. Backoff on, as on every job we insert, which `retryDelayMax` needs. */
export const queueConfig = (queue: PgBossTuning["queue"]) => ({ ...queue, retryBackoff: true });

/** `meta.pgBoss` as `PgBossMeta` types it where you write it (meta is stored loose). */
export const tuningOf = (meta: Readonly<Record<string, unknown>> | undefined) => meta?.pgBoss as PgBossTuning | undefined;

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

/**
 * A job as a pg-boss row. Its tries are stamped here, as pg-boss counts them (retries after the first), plus one that
 * never runs: when the last try's worker dies, pg-boss's supervisor expires the job without our code, and with a retry
 * left it comes back to `registry.jobs.run`, which fails it past its attempts and reports it, as Laravel's worker does
 * at pickup. A last try that throws is `deadletter`, so it never uses the spare.
 */
const rowOf = (job: Job, replaceKey?: string): JobInsert<Job> => ({
  id: pgBossId(job.id),
  data: job,
  startAfter: job.runAt,
  retryLimit: job.attempts,
  retryBackoff: true, // pg-boss retries at once by default; this waits 1 to 2 s, then 2 to 4 s, 4 to 8 s…
  singletonKey: replaceKey,
});

export function pgBoss(boss: PgBoss): JobsAdapter {
  let database: SqlDatabase | undefined;
  /** pg-boss's SQL on your mutation's transaction, through your database adapter's `query`: any ORM that runs SQL. */
  const inTx = (tx: unknown): Db => ({
    executeSql: async (text, values = []) => {
      const rows = await database!.query(tx, text, values);
      return { rows };
    },
  });
  const queueOptions = new Map<string, PgBossTuning["queue"]>();

  /**
   * pg-boss needs a job's queue to exist, and `work()` creates them all; this covers a process that enqueues first (a
   * new listener, deployed before its worker). pg-boss looks it up and creates it on its own connection, before any SQL
   * on your transaction, so the transaction is fine (on PGlite, with one connection, it would wait: run `work()` first).
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
      // one replacer per key at a time, so the second sees the first's call and replaces it (databaseQueue's unique index)
      await db.executeSql("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`logic-sdk.replace:${key}`]);
      // a no-op edit that locks the key's queued jobs: a worker's fetch skips locked rows, so none starts while we look
      const { jobs: locked } = await boss.update(CALLS_QUEUE, undefined, { singletonKey: key, match: "all", db });
      if (!locked.length) continue;
      const queued = await boss.findJobs<Job>(CALLS_QUEUE, { key, queued: true, db });
      const waiting = queued.filter((j) => j.state === "created").map((j) => j.id); // `retry` ones have started
      if (waiting.length) await boss.deleteJob(CALLS_QUEUE, waiting, { db });
    }
  }

  return {
    name: "pgBoss(boss)",
    retries: true, // retryLimit, stamped from the job's attempts
    sql: true, // pg-boss inserts its jobs with your database adapter's `query`, in your transaction
    holds: true, // `startAfter`, however far ahead
    replaces: true,
    /** Takes the registry's database: jobs are inserted in the mutation's transaction, and `retry` opens its own through it. */
    connect({ listeners, crons, sql }) {
      database = sql;
      for (const l of listeners) queueOptions.set(queueName(l.id), tuningOf(l.listener.meta)?.queue);
      for (const c of crons) queueOptions.set(queueName(c.id), tuningOf(c.cron.meta)?.queue);
    },
    /** Inside the mutation's transaction: one insert per queue. pg-boss skips a row whose id it already has. */
    async enqueue(tx, jobs) {
      const db = inTx(tx);
      for (const [name, list] of Map.groupBy(jobs, queueOf)) {
        const keyed = await Promise.all(list.map(async (job) => ({ job, key: await storedReplaceKey(job) })));
        const keys = keyed.map(({ key }) => key).filter((key) => key !== undefined);
        await inQueue(name, async () => {
          if (keys.length) await replaceWaiting(db, keys);
          await boss.insert(name, keyed.map(({ job, key }) => rowOf(job, key)), { db });
        });
      }
    },
    /** pg-boss's workers pick jobs up (`work()`), so there's nothing to do after commit. */
    async deliver() {},
    /**
     * A failed job, back in line with a fresh set of attempts (pg-boss's own `retry` gives one more). Its replace key goes:
     * it has run, so it's no longer a call a newer one replaces.
     */
    async retry(id) {
      const queues = await queuesOf(id);
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
          // as new: retry count 0, and its retries again
          await boss.deleteJob(name, uuid, { db });
          await boss.insert(name, [rowOf(failed.data)], { db });
          return true;
        }
        return false;
      });
    },
    /** pg-boss keeps failed jobs in its own tables, one queue at a time, with no state filter: list them there. */
    async failed() {
      throw new Error("[logic-sdk] pgBoss(boss) can't list failed jobs across queues: use boss.findJobs(queue) for one, and pgBossId(id) to match ids.");
    },
    /** A failed job, deleted. A waiting, running or retrying one is left alone. */
    async forget(id) {
      const queues = await queuesOf(id);
      if (!database || !queues.length) return false;
      const uuid = pgBossId(id);
      return database.transaction(async (tx) => {
        const db = inTx(tx);
        for (const { name } of queues) {
          const [found] = await boss.findJobs<Job>(name, { id: uuid, db });
          if (found?.state !== "failed") continue;
          await boss.deleteJob(name, uuid, { db });
          return true;
        }
        return false;
      });
    },
  };

  /**
   * A job id's queues: its listener's or cron's (the id's prefix), and the calls queue. Looked up before any
   * transaction: inside one, a lookup on pg-boss's own connection would wait for it on PGlite.
   */
  async function queuesOf(id: string) {
    const at = id.lastIndexOf("@");
    if (at < 0) return []; // not a job id
    const names = [queueName(id.slice(0, at)), CALLS_QUEUE].filter((name) => /^[\w.\-/]+$/.test(name)); // pg-boss's rule: an id from anywhere
    return boss.getQueues(names);
  }
}
