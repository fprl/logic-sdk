import { z } from "zod";
import { mutation } from "./init";

// A single-file module: fine for small modules
/** Reserve stock */
export const reserve = mutation({
  id: "hold",
  input: z.object({ sku: z.string() }),
  handler: async (_, { sku }) => ({ sku, at: new Date().toISOString() }), // ! reads the clock
});
