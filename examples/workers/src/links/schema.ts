import { createSelectSchema } from "drizzle-orm/zod";
import { text, timestamp, snakeCase } from "drizzle-orm/pg-core";

export const links = snakeCase.table("links", {
  slug: text().primaryKey(),
  url: text().notNull(),
  createdBy: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** What callers get back. */
export const Link = createSelectSchema(links);
