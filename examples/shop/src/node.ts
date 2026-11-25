import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import { drizzleAdapter } from "logic-sdk/drizzle/pg";
import { startTicking } from "logic-sdk/node";
import postgres from "postgres";
import { createApi } from "./http";
import { createShop, settingsFrom } from "./registry";

// Node: one shop and one pool for the whole process.
const shop = createShop({
  database: drizzleAdapter(drizzle({ client: postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5442/postgres") })),
  settings: settingsFrom(process.env),
});

const app = createApi(() => shop);

serve({ fetch: app.fetch, port: 3000 }, (info) => console.log(`http://localhost:${info.port}`));

// every minute: the crons in code (orders.sendDigest), and the jobs a crash or a failure left in the table
startTicking(shop);
