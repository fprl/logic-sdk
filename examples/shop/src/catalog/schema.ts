import { createSelectSchema } from "drizzle-orm/zod";
import { integer, text, snakeCase } from "drizzle-orm/pg-core";

export const products = snakeCase.table("products", {
  sku: text().primaryKey(),
  name: text().notNull(),
  price: integer().notNull(), // cents
  stock: integer().notNull(),
});

/** What callers get back. */
export const Product = createSelectSchema(products);
