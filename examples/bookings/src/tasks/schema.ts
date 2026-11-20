import { createSelectSchema } from "drizzle-orm/zod";
import { text, uuid, snakeCase } from "drizzle-orm/pg-core";

export const tasks = snakeCase.table("tasks", {
  id: uuid().primaryKey().defaultRandom(),
  accountId: text().notNull(),
  title: text().notNull(),
  bookingId: uuid(),
  status: text({ enum: ["todo", "done"] }).notNull().default("todo"),
});

export const Task = createSelectSchema(tasks).omit({ accountId: true });
