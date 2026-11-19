import { createSelectSchema } from "drizzle-orm/zod";
import { date, integer, text, uuid, snakeCase } from "drizzle-orm/pg-core";

export const bookings = snakeCase.table("bookings", {
  id: uuid().primaryKey().defaultRandom(),
  accountId: text().notNull(),
  propertyId: uuid().notNull(),
  enquiryId: uuid(),
  guestEmail: text().notNull(),
  checkIn: date().notNull(),
  checkOut: date().notNull(),
  total: integer().notNull(), // cents
  status: text({ enum: ["pending", "confirmed", "cancelled"] }).notNull().default("pending"),
});

/** What callers get back: the row without internal columns. */
export const Booking = createSelectSchema(bookings).omit({ accountId: true });
