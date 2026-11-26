// A Cloudflare Queue and its consumer's batches, faked, and a module that emits: for the adapter's and the hosts' tests.
import { z } from "zod";
import { init, type Job } from "../../src/index.ts";
import type { QueueBatch } from "../../src/cloudflare.ts";
import type { Store } from "./memory-db.ts";

export type Scope = { actor: string };
export const { mutation, event, listener, cron, createRegistry } = init<{ scope: Scope; db: Store }>();

export const happened = event({ payload: z.object({ what: z.string() }) });
export const emit = mutation({ input: z.object({ what: z.array(z.string()) }), async handler(ctx, { what }) {
  for (const w of what) ctx.emit(happened, { what: w });
} });
export const ran: string[] = [];
export const react = listener({ event: () => happened, attempts: 3, async handler(ctx, { what }) {
  if (what === "throw") throw new Error("smtp down");
  if (what === "deny") throw ctx.errors.reject("nope");
  ran.push(`${what}#${ctx.event.attempt}`);
} });
export const modules = { x: { happened, emit, react } };

export type Message = { body: Job; delaySeconds?: number };
/** A fake binding: what was sent, batch by batch. */
export const fakeQueue = () => {
  const sent: Message[][] = [];
  return { sent, async sendBatch(messages: Iterable<Message>) { sent.push([...messages]); } };
};
/** A fake consumer batch: which messages were acked, and which retried after how long. */
export const batchOf = (jobs: Job[], attempts = 1) => {
  const acked: string[] = [];
  const retried: [string, number | undefined][] = [];
  const batch: QueueBatch = {
    messages: jobs.map((body) => ({
      body,
      attempts,
      ack: () => acked.push(body.id),
      retry: (options) => retried.push([body.id, options?.delaySeconds]),
    })),
  };
  return { batch, acked, retried };
};
