// The entry: reads process.env inline and builds the registry from it. Never flagged.
import { createRegistry } from "./logic";
import * as orders from "./orders";

const payments = { key: process.env.STRIPE_KEY! }; // a client from a secret: goes in services
export const registry = createRegistry({
  modules: { orders },
  database: {} as any, // your adapter
  services: { payments },
  config: { app: { url: process.env.APP_URL ?? "http://localhost" }, orders: { maxItems: Number(process.env.MAX_ITEMS ?? 20), currency: "EUR", tags: [] } },
});
