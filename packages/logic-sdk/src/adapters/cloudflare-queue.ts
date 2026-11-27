import type { Job, JobsAdapter } from "../core/types.ts";

/** What the adapter uses of a Cloudflare Queue binding: `env.JOBS` fits. */
export interface QueueBinding {
  sendBatch(messages: Iterable<{ body: Job; delaySeconds?: number }>): Promise<unknown>;
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
 * them); behind an outbox it's durable: `jobs: { adapter: outbox(cloudflareQueue(env.JOBS)), scope: { store, load } }`.
 * Run them with `handleQueue(registry, batch)` in your consumer. With `jobs.queues`, one binding per queue, `"default"`
 * included: `cloudflareQueue({ default: env.JOBS, mail: env.MAIL })`.
 */
export function cloudflareQueue(queue: QueueBinding | Readonly<Record<string, QueueBinding>>): JobsAdapter {
  const one = typeof queue.sendBatch === "function";
  const bindings = (one ? { default: queue } : queue) as Readonly<Record<string, QueueBinding>>;
  return {
    name: one ? "cloudflareQueue(queue)" : `cloudflareQueue({ ${Object.keys(bindings).join(", ")} })`,
    retries: true, // handleQueue retries a message with a backoff
    holds: { max: MAX_DELAY }, // delaySeconds, up to 24 hours
    ...(one ? {} : { queues: Object.keys(bindings) }),
    async deliver(jobs) {
      const byQueue = Map.groupBy(jobs, (job) => job.queue ?? "default");
      for (const [name, some] of byQueue) {
        const binding = bindings[name];
        if (!binding) throw new Error(`[logic-sdk] cloudflareQueue has no binding for queue ${JSON.stringify(name)}.`);
        for (const batch of batches(some)) await binding.sendBatch(batch);
      }
    },
  };
}

/** Under Cloudflare's limits per send: 100 messages, 256 KB in all, 128 KB each. Checks every job before sending any. */
function* batches(jobs: Job[]) {
  const sized = jobs.map((body) => {
    const size = encoder.encode(JSON.stringify(body)).length + OVERHEAD_BYTES;
    if (size > MAX_MESSAGE_BYTES)
      throw new Error(`[logic-sdk] job ${body.id} is ${size} bytes; Cloudflare Queues take ${MAX_MESSAGE_BYTES} per message. Keep payloads to ids.`);
    return { body, size };
  });
  let batch: { body: Job; delaySeconds?: number }[] = [];
  let bytes = 0;
  for (const { body, size } of sized) {
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
