import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApi } from "./http";
import { createShop, settingsFrom } from "./shop";

type Bindings = { HYPERDRIVE: { connectionString: string }; APP_URL: string; MAX_ITEMS: string };

// Workers: a shop per request, on this request's Hyperdrive connection. Listeners finish after the response.
export default createApi<Bindings>((c) =>
  createShop({
    db: drizzle({ client: postgres(c.env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false }) }),
    settings: settingsFrom(c.env),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  }),
);
