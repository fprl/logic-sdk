import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import { startTicking } from "logic-sdk/node";
import postgres from "postgres";
import { createApi } from "./http";
import { createShop, settingsFrom } from "./registry";

// Node: one shop and one pool for the whole process.
const shop = createShop({
  db: drizzle({ client: postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5442/postgres") }),
  settings: settingsFrom(process.env),
});

const app = createApi(() => shop);

serve({ fetch: app.fetch, port: 3000 }, (info) => console.log(`http://localhost:${info.port}`));

// the crons in code (orders.morningDigest), on the minute. One server: inProcess() runs each once.
startTicking(shop);
