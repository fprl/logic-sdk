import { z } from "zod";
import { mutation } from "../logic";
import { tasks } from "./schema";

/** Create an operations task */
export const create = mutation({
  input: z.object({ title: z.string().min(1), bookingId: z.uuid().optional() }),
  async handler(ctx, input) {
    const [t] = await ctx.db.insert(tasks).values({ ...input, accountId: ctx.scope.accountId }).returning();
    return t!;
  },
});
