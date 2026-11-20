import { createSelectSchema } from "drizzle-orm/zod";
import { date, text, uuid, snakeCase } from "drizzle-orm/pg-core";

// Availability owns occupancy. It never reads bookings or properties tables.
export const holds = snakeCase.table("availability_holds", {
  id: uuid().primaryKey().defaultRandom(),
  propertyId: uuid().notNull(),
  from: date().notNull(), // inclusive
  to: date().notNull(), // exclusive (checkout day)
  reason: text({ enum: ["booking", "owner_block", "maintenance", "channel_sync"] }).notNull(),
  sourceId: text().notNull(),
});

export const Hold = createSelectSchema(holds);
