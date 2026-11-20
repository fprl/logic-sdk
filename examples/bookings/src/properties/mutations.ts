import { z } from "zod";
import { mutation } from "../logic";
import { owner } from "../policies";
import { Property, properties } from "./schema";

/** Add a property to the account */
export const create = mutation({
  input: z.object({
    name: z.string().min(1),
    nightlyRate: z.int().positive(),
    cleaningFee: z.int().min(0),
    minNights: z.int().min(1).default(1),
  }),
  authorize: owner,
  expose: true,
  output: Property,
  async handler(ctx, input) {
    const [p] = await ctx.db.insert(properties).values({ ...input, accountId: ctx.scope.accountId }).returning();
    return p!;
  },
});
