import { z } from "zod";
import { mutation } from "../init";

export const release = mutation({
  description: "Release stock",
  inputSchema: z.object({ sku: z.string() }),
  execute: async ({ sku }) => ({ sku }),
});
