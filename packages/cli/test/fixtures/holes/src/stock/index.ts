import { z } from "zod";
import { mutation } from "../init";

/** Reserve stock */
export const reserve = mutation({
  input: z.object({ sku: z.string() }),
  handler: async (_, { sku }) => ({ sku }),
});
