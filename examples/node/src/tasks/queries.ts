import { eq } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { agent } from "../policies";
import { Task, tasks } from "./schema";

export const list = query({
  description: "Open tasks for the account",
  inputSchema: z.object({}).optional(),
  authorize: agent,
  expose: true,
  outputSchema: z.array(Task),
  execute: (_, { db, scope }) => db.select().from(tasks).where(eq(tasks.accountId, scope.accountId)),
});
