import { z } from "zod";
import { mutation } from "../logic";
import { tasks } from "./schema";

export const create = mutation({
  description: "Create an operations task",
  inputSchema: z.object({ title: z.string().min(1), bookingId: z.uuid().optional() }),
  async execute(input, { db, scope }) {
    const [t] = await db.insert(tasks).values({ ...input, accountId: scope.accountId }).returning();
    return t!;
  },
});
