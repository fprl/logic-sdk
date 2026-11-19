import { integer, text, snakeCase } from "drizzle-orm/pg-core";

export const visits = snakeCase.table("visits", {
  slug: text().primaryKey(),
  count: integer().notNull().default(0),
});
