import { z } from "zod";
import { mutation } from "./init";

// A single-file module: fine for small modules
export const reserve = mutation({
  description: "Reserve stock",
  input: z.object({ sku: z.string() }),
  handler: async (_, { sku }) => ({ sku }),
});
