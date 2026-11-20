import { z } from "zod";
import { mutation } from "../init";

/** Release stock */
export const release = mutation({
  input: z.object({ sku: z.string() }),
  handler: async (_, { sku }) => ({ sku }),
});
