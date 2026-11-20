import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db, Mailer, Scope } from "../src/logic";
import { createShop } from "../src/registry";

/** The real Postgres engine, in process (PGlite): no Docker needed. Each test is a rolled-back transaction. */
const pg = new PGlite();
await pg.exec(readFileSync(new URL("../src/db/migrate.sql", import.meta.url), "utf8"));

export const shop = createShop({
  db: drizzle({ client: pg }) as unknown as Db,
  settings: { app: { url: "https://shop.test" }, orders: { maxItems: 10 } },
});

export function memoryMailer() {
  const sent: Parameters<Mailer["send"]>[0][] = [];
  return { sent, send: async (mail: (typeof sent)[number]) => void sent.push(mail) };
}

export const guest: Scope = { user: null };
export const ana: Scope = { user: { id: "ana", role: "customer" } };
export const leo: Scope = { user: { id: "leo", role: "customer" } };
export const sam: Scope = { user: { id: "sam", role: "staff" } };
