import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { sqlState } from "logic-sdk/drizzle";
import postgres from "postgres";
import { expect, test } from "vitest";
import * as orders from "../src/orders";
import { createShop } from "../src/registry";
import { ana, memoryMailer } from "./setup";

// PGlite runs one transaction at a time, so it can't race. This needs real Postgres: CI sets DATABASE_URL.
test.skipIf(!process.env.DATABASE_URL)("carts with the same products in any order don't deadlock", async () => {
  // its own schema: other workspaces' tests share this database
  const client = postgres(process.env.DATABASE_URL!, { max: 10, onnotice: () => {}, connection: { search_path: "shop_race" } });
  await client`create schema if not exists shop_race`;
  await client.unsafe(readFileSync(new URL("../src/db/migrate.sql", import.meta.url), "utf8"));
  await client`update products set stock = 10000`;

  const shop = createShop({
    db: drizzle({ client }),
    settings: { app: { url: "https://shop.test" }, orders: { maxItems: 10 } },
    mailer: memoryMailer(),
  });
  const mug = { sku: "mug", quantity: 1 };
  const tee = { sku: "tee", quantity: 1 };

  for (let round = 0; round < 10; round++) {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => shop.as(ana).run(orders.place, { items: i % 2 ? [mug, tee] : [tee, mug] })),
    );
    expect(outcomes.flatMap((o) => (o.status === "rejected" ? [sqlState(o.reason) ?? String(o.reason)] : []))).toEqual([]); // never a 40P01
  }
  await client.end();
});
