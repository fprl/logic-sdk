import type { Dispatcher, Job, Jobs } from "./index.ts";

/** What the adapter uses of a Cloudflare Queue binding: `env.JOBS` fits. */
export interface QueueBinding {
  sendBatch(messages: Iterable<{ body: Job }>): Promise<unknown>;
}

/** What the handler uses of a consumer's `MessageBatch<Job>`. Type your Worker with `ExportedHandler<Env, Job>`. */
export interface QueueBatch {
  readonly messages: readonly {
    readonly body: Job;
    readonly attempts: number;
    ack(): void;
    retry(): void;
  }[];
}

// Cloudflare's limits per sendBatch: https://developers.cloudflare.com/queues/platform/limits/
const MAX_MESSAGES = 100;
const MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/**
 * Send jobs to a Cloudflare Queue after commit. Alone it's lossy (a Worker that dies between commit and send loses
 * them); inside the outbox it's durable: `jobs: { adapter: outbox(db, { via: cloudflareQueue(env.JOBS) }) }`.
 * Retries, `retry_delay` and the dead-letter queue are the consumer's config in wrangler.
 */
export function cloudflareQueue(queue: QueueBinding): Dispatcher {
  return {
    async deliver(jobs) {
      for (const batch of batches(jobs)) await queue.sendBatch(batch);
    },
  };
}

/** Under Cloudflare's limits: 100 messages or 256 KB per send. */
function* batches(jobs: Job[]) {
  let batch: { body: Job }[] = [];
  let bytes = 0;
  for (const body of jobs) {
    const size = encoder.encode(JSON.stringify(body)).length;
    if (batch.length && (batch.length === MAX_MESSAGES || bytes + size > MAX_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push({ body });
    bytes += size;
  }
  if (batch.length) yield batch;
}

/**
 * The Worker's `queue` handler: runs each message's job, then acknowledges it (`done`, `failed`, `discarded`) or
 * retries it (the job threw). One message at a time, each acknowledged on its own, so one failure doesn't redeliver
 * the batch.
 *
 * ```ts
 * queue: (batch, env, ctx) => toQueueHandler(makeRegistry(env, ctx))(batch),
 * ```
 */
export function toQueueHandler(registry: { jobs: Pick<Jobs, "run"> }) {
  return async (batch: QueueBatch) => {
    for (const message of batch.messages) {
      try {
        await registry.jobs.run(message.body, { attempt: message.attempts });
        message.ack();
      } catch {
        message.retry(); // already reported to onError
      }
    }
  };
}
