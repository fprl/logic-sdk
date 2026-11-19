import { createSelectSchema } from "drizzle-orm/zod";
import { integer, jsonb, text, timestamp, uuid, snakeCase } from "drizzle-orm/pg-core";
import { z } from "zod";

export const Line = z.object({ sku: z.string(), name: z.string(), price: z.int(), quantity: z.int() });

export const orders = snakeCase.table("orders", {
  id: uuid().primaryKey().defaultRandom(),
  customerId: text().notNull(),
  status: text({ enum: ["placed", "shipped", "cancelled"] }).notNull().default("placed"),
  items: jsonb().$type<z.infer<typeof Line>[]>().notNull(), // name and price as they were when ordered
  total: integer().notNull(), // cents
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

/** What callers get back. */
export const Order = createSelectSchema(orders, { items: z.array(Line) });
