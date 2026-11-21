import type { Dispatcher, Job, Jobs } from "./index.ts";

/** What the adapter uses of a Cloudflare Queue binding: `env.JOBS` fits. */
export interface QueueBinding {
  sendBatch(messages: Iterable<{ body: Job; delaySeconds?: number }>): Promise<unknown>;
}

/** What the handler uses of a consumer's `MessageBatch<Job>`. Type your Worker with `ExportedHandler<Env, Job>`. */
export interface QueueBatch {
  readonly messages: readonly {
    readonly body: Job;
    readonly attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }[];
}

// Cloudflare's limits, where 1 KB is 1000 bytes: https://developers.cloudflare.com/queues/platform/limits/
const MAX_MESSAGES = 100;
const MAX_BATCH_BYTES = 256_000;
const MAX_MESSAGE_BYTES = 128_000;
/** Cloudflare counts about this much metadata per message toward the limits. */
const OVERHEAD_BYTES = 100;
/** The longest `delaySeconds` Cloudflare takes, for a send and for a retry: 24 hours. */
const MAX_DELAY = 86_400;
const encoder = new TextEncoder();

/**
 * Send jobs to a Cloudflare Queue after commit. Alone it's lossy (a Worker that dies between commit and send loses
 * them); inside the outbox it's durable: `jobs: { adapter: outbox(db, { via: cloudflareQueue(env.JOBS) }) }`.
 * Run them with `handleQueue(registry, batch)` in your consumer.
 */
export function cloudflareQueue(queue: QueueBinding): Dispatcher {
  return {
    check({ listeners }) {
      for (const { id, listener } of listeners)
        if ((listener.delay ?? 0) > MAX_DELAY)
          throw new Error(
            `[logic-sdk] ${id} has a delay of ${listener.delay} seconds; Cloudflare Queues delay at most ${MAX_DELAY} (24 hours). ` +
              "Put the outbox in front, outbox(db, { via: cloudflareQueue(env.JOBS) }): it holds longer delays itself.",
          );
    },
    async deliver(jobs) {
      for (const batch of batches(jobs)) await queue.sendBatch(batch);
    },
  };
}

/** Under Cloudflare's limits per send: 100 messages, 256 KB in all, 128 KB each. */
function* batches(jobs: Job[]) {
  let batch: { body: Job; delaySeconds?: number }[] = [];
  let bytes = 0;
  for (const body of jobs) {
    const size = encoder.encode(JSON.stringify(body)).length + OVERHEAD_BYTES;
    if (size > MAX_MESSAGE_BYTES)
      throw new Error(`[logic-sdk] job ${body.id} is ${size} bytes; Cloudflare Queues take ${MAX_MESSAGE_BYTES} per message. Keep payloads to ids.`);
    if (batch.length && (batch.length === MAX_MESSAGES || bytes + size > MAX_BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(body.runAt ? { body, delaySeconds: secondsUntil(body.runAt) } : { body });
    bytes += size;
  }
  if (batch.length) yield batch;
}

const secondsUntil = (iso: string) => Math.min(MAX_DELAY, Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000)));

/**
 * Your Worker's `queue` handler: runs each message's job, then acknowledges it (`done`, `failed`, `discarded`) or
 * retries it with a backoff (it threw and the listener has tries left). One message at a time, each acknowledged on
 * its own, so one failure doesn't redeliver the batch.
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
      // already reported to onError. The outbox's curve, so a listener's tries aren't spent back to back.
      message.retry({ delaySeconds: Math.ceil(Math.exp(Math.min(message.attempts, 10))) });
    }
  }
}
