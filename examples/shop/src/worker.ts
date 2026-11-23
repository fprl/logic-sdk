import { drizzle } from "drizzle-orm/postgres-js";
import type { Job } from "logic-sdk";
import { cloudflareQueue, handleQueue, handleScheduled } from "logic-sdk/cloudflare";
import { drizzleAdapter, outbox } from "logic-sdk/drizzle/pg";
import postgres from "postgres";
import { createApi } from "./http";
import { createShop, settingsFrom } from "./registry";

// Workers: a shop per request, on this request's Hyperdrive connection. Its jobs run through Cloudflare Queues, behind
// an outbox so none is lost between commit and send. `Env` comes from wrangler.jsonc: `wrangler types`.
const shopFor = (env: Env, ctx: Pick<ExecutionContext, "waitUntil">) => {
  const database = drizzleAdapter(drizzle({ client: postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false }) }));
  return createShop({
    database,
    settings: settingsFrom(env),
    jobs: outbox(database, cloudflareQueue(env.JOBS)),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
};

const api = createApi<Env>((c) => shopFor(c.env, c.executionCtx));

export default {
  fetch: api.fetch,
  // the queue's consumer: runs each job
  async queue(batch, env, ctx) {
    await handleQueue(shopFor(env, ctx), batch);
  },
  // every minute: the crons in code (orders.morningDigest), and what never reached the queue
  async scheduled(controller, env, ctx) {
    await handleScheduled(shopFor(env, ctx), controller);
  },
} satisfies ExportedHandler<Env, Job>;
