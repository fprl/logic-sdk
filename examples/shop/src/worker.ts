import { drizzle } from "drizzle-orm/postgres-js";
import { handleScheduled } from "logic-sdk/cloudflare";
import postgres from "postgres";
import { createApi } from "./http";
import { createShop, settingsFrom } from "./registry";

type Bindings = { HYPERDRIVE: { connectionString: string }; APP_URL: string; MAX_ITEMS: string };

// Workers: a shop per request, on this request's Hyperdrive connection. Listeners finish after the response.
const shopFor = (env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }) =>
  createShop({
    db: drizzle({ client: postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false }) }),
    settings: settingsFrom(env),
    waitUntil: (promise) => ctx.waitUntil(promise),
  });

const api = createApi<Bindings>((c) => shopFor(c.env, c.executionCtx));

export default {
  fetch: api.fetch,
  // the crons in code (orders.morningDigest), run by wrangler's trigger
  async scheduled(controller: { scheduledTime: number }, env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    await handleScheduled(shopFor(env, ctx), controller);
  },
};
