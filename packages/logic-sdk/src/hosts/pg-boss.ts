// `work()`, the pg-boss worker: its queues and names are the adapter's (adapters/pg-boss.ts).
import type { JobResult, PgBoss } from "pg-boss";
import { CALLS_QUEUE, PREFIX, queueConfig, queueName, tuningOf, type PgBossTuning } from "../adapters/pg-boss.ts";
import type { Job, Jobs, Registry } from "../core/types.ts";
import { startTicking } from "./node.ts";

export interface PgBossWorkOptions {
  /** The shared queue of scheduled calls, tuned like a listener's `meta.pgBoss`: `{ worker: { localConcurrency: 10 } }`. */
  calls?: PgBossTuning;
  /** Where a failed cron tick goes, and a queue left with jobs but no listener. Default `console.error`. */
  onError?: (error: unknown) => void;
}

/**
 * Your worker process: a queue and its workers for every listener and cron, one for scheduled calls, and the cron tick
 * every minute. `boss.stop()` stops all of it. Applies each listener's and cron's `meta.pgBoss`.
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
  const onError = options.onError ?? ((error) => console.error("[logic-sdk]", error));
  const queues: { name: string; tuning: PgBossTuning | undefined }[] = [
    ...listeners.map((l) => ({ name: queueName(l.id), tuning: tuningOf(l.listener.meta) })),
    ...crons.map((c) => ({ name: queueName(c.id), tuning: tuningOf(c.cron.meta) })),
    { name: CALLS_QUEUE, tuning: options.calls },
  ];

  /** One job's try. `failed` is over (out of tries, or retrying can't help), so pg-boss mustn't retry it. */
  const settle = async (job: { id: string; data: Job; retryCount: number }): Promise<JobResult> => {
    let reason: unknown;
    const fail = async (error: unknown) => {
      reason = error; // kept by pg-boss as the failed job's output
    };
    try {
      const outcome = await registry.jobs.run(job.data, { attempt: job.retryCount + 1, fail });
      if (outcome === "failed") return { id: job.id, status: "deadletter", output: reason };
      return { id: job.id, status: "completed" };
    } catch (error) {
      return { id: job.id, status: "failed", output: error }; // reported already; pg-boss retries it after a backoff
    }
  };

  for (const { name, tuning } of queues) {
    const config = queueConfig(tuning?.queue);
    const { partition: _createOnly, ...updatable } = config;
    await boss.createQueue(name, config); // a no-op when it exists, so its options are updated below
    await boss.updateQueue(name, updatable);
    await boss.work<Job>(name, { ...tuning?.worker, perJobResults: true }, (jobs) => Promise.all(jobs.map(settle)));
  }

  // a renamed or removed listener leaves its queue with no worker, and pg-boss's retention deletes those jobs unrun.
  // They never get a try that could report, so say so here
  const ours = new Set(queues.map((q) => q.name));
  for (const q of await boss.getQueues())
    if (q.name.startsWith(PREFIX) && !ours.has(q.name) && q.queuedCount > 0)
      onError(new Error(`[logic-sdk] pg-boss queue ${q.name} has ${q.queuedCount} job(s) and no listener or cron here (renamed or removed?). Give it its old id back, or delete the queue.`));

  if (!crons.length) return;
  // ticked by every worker: the minute's job id is the same everywhere, so pg-boss inserts one row
  const stop = startTicking(registry, { sweepEvery: 0, onError });
  boss.once("stopped", () => void stop());
}
