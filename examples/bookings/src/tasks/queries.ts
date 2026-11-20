import { eq } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { agent } from "../policies";
import { Task, tasks } from "./schema";

/** Open tasks for the account */
export const list = query({
  input: z.object({}).optional(),
  authorize: agent,
  expose: true,
  output: z.array(Task),
  handler: (ctx) => ctx.db.select().from(tasks).where(eq(tasks.accountId, ctx.scope.accountId)),
});
