import { createSelectSchema } from "drizzle-orm/zod";
import { text, timestamp, uuid, snakeCase } from "drizzle-orm/pg-core";

export const enquiries = snakeCase.table("enquiries", {
  id: uuid().primaryKey().defaultRandom(),
  accountId: text().notNull(),
  propertyId: uuid().notNull(),
  guestEmail: text().notNull(),
  message: text().notNull(),
  status: text({ enum: ["open", "won", "lost"] }).notNull().default("open"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const Enquiry = createSelectSchema(enquiries).omit({ accountId: true });
