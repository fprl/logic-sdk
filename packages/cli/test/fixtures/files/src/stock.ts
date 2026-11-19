import { z } from "zod";
import { mutation } from "./init";

// A single-file module: fine for small modules
export const reserve = mutation({
  description: "Reserve stock",
  inputSchema: z.object({ sku: z.string() }),
  execute: async ({ sku }) => ({ sku }),
});
