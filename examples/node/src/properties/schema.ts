import { createSelectSchema } from "drizzle-orm/zod";
import { integer, text, uuid, snakeCase } from "drizzle-orm/pg-core";

export const properties = snakeCase.table("properties", {
  id: uuid().primaryKey().defaultRandom(),
  accountId: text().notNull(),
  name: text().notNull(),
  nightlyRate: integer().notNull(), // cents
  cleaningFee: integer().notNull(), // cents
  minNights: integer().notNull().default(1),
});

export const Property = createSelectSchema(properties).omit({ accountId: true });
