import { z } from "zod";
import { mutation } from "../../init";

export const reserve = mutation({
  description: "Reserve stock",
  inputSchema: z.object({ sku: z.string() }),
  execute: async ({ sku }) => ({ sku }),
});
