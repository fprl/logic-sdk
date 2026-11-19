import { drizzle } from "drizzle-orm/postgres-js";
import { after } from "next/server";
import postgres from "postgres";
import { createShop, settingsFrom } from "../shop";

// Next.js: one shop and one pool for the server (dev hot reload opens a new pool per reload; fine for a demo).
// Listeners run after the response, through Next's `after`.
const shop = createShop({
  db: drizzle({ client: postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5442/postgres") }),
  settings: settingsFrom(process.env),
  waitUntil: (promise) => after(() => promise),
});

// Demo auth: you're always ana. Put your real session lookup here.
export const caller = () => shop.as({ user: { id: "ana", role: "customer" } });
