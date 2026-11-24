import { z } from "zod";
import { mutation } from "../init";
import { log } from "../shared/audit";

/** Reserve stock */
export const hold = mutation({
  input: z.object({ sku: z.string() }),
  handler: async (ctx, { sku }) => {
    await ctx.run(log);
    return { sku };
  },
});
