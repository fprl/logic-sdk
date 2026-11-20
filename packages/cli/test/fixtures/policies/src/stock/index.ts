import { z } from "zod";
import { mutation } from "../init";

export const release = mutation({
  description: "Release stock",
  input: z.object({ sku: z.string() }),
  handler: async (_, { sku }) => ({ sku }),
});
