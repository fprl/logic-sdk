import { defaultBackoff } from "../core/jobs.ts";
import type { Job, Jobs } from "../core/types.ts";

/** What the handler uses of a consumer's `MessageBatch<Job>`. Type your Worker with `ExportedHandler<Env, Job>`. */
export interface QueueBatch {
  readonly messages: readonly {
    readonly body: Job;
    readonly attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }[];
}

/**
 * Your Worker's `queue` handler: runs each message's job, then acknowledges it (`done`, `failed`, `discarded`) or
 * retries it with a backoff (it threw). One message at a time, each acknowledged on its own, so one failure doesn't
 * redeliver the batch. Alone, a throw means the listener has tries left. Behind an outbox, a message is a signal: the
 * job runs from its row (with a `key`, the key's next jobs, in order), and a throw means the table couldn't be reached.
 *
 * ```ts
 * async queue(batch, env, ctx) {
 *   await handleQueue(makeRegistry(env, ctx), batch);
 * },
 * ```
 */
export async function handleQueue(registry: { jobs: Pick<Jobs, "run"> }, batch: QueueBatch): Promise<void> {
  for (const message of batch.messages) {
    try {
      await registry.jobs.run(message.body, { attempt: message.attempts });
      message.ack();
    } catch {
      // already reported to onError. databaseQueue's curve, so a listener's tries aren't spent back to back.
      message.retry({ delaySeconds: Math.ceil(defaultBackoff(message.attempts)) });
    }
  }
}

/**
 * Your Worker's `scheduled` handler: runs the crons due at the trigger's time, then sweeps (the jobs table's retries,
 * delayed jobs, and what a lost signal or a crash left behind). Use `"* * * * *"`, or one trigger per cron: Cloudflare numbers weekdays
 * 1 = Sunday, so write them as names (`MON`) in both places.
 *
 * ```ts
 * async scheduled(controller, env, ctx) {
 *   await handleScheduled(makeRegistry(env, ctx), controller);
 * },
 * ```
 */
export async function handleScheduled(
  registry: { jobs: Pick<Jobs, "tick" | "sweep"> },
  controller: { readonly scheduledTime: number },
): Promise<void> {
  await registry.jobs.tick(new Date(controller.scheduledTime));
  await registry.jobs.sweep();
}
