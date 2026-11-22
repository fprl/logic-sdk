import { drizzle } from "drizzle-orm/postgres-js";
import { cloudflareQueue, handleQueue, handleScheduled, type QueueBatch, type QueueBinding } from "logic-sdk/cloudflare";
import { outbox } from "logic-sdk/drizzle";
import postgres from "postgres";
import { createApi } from "./http";
import { createShop, settingsFrom } from "./registry";

type Bindings = { HYPERDRIVE: { connectionString: string }; JOBS: QueueBinding; APP_URL: string; MAX_ITEMS: string };
type Waiting = { waitUntil(promise: Promise<unknown>): void };

// Workers: a shop per request, on this request's Hyperdrive connection. Its jobs run through Cloudflare Queues, behind
// an outbox so none is lost between commit and send.
const shopFor = (env: Bindings, ctx: Waiting) => {
  const db = drizzle({ client: postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false }) });
  return createShop({
    db,
    settings: settingsFrom(env),
    jobs: outbox(db, cloudflareQueue(env.JOBS)),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
};

const api = createApi<Bindings>((c) => shopFor(c.env, c.executionCtx));

export default {
  fetch: api.fetch,
  // the queue's consumer: runs each job
  async queue(batch: QueueBatch, env: Bindings, ctx: Waiting) {
    await handleQueue(shopFor(env, ctx), batch);
  },
  // every minute: the crons in code (orders.morningDigest), and what never reached the queue
  async scheduled(controller: { scheduledTime: number }, env: Bindings, ctx: Waiting) {
    await handleScheduled(shopFor(env, ctx), controller);
  },
};
