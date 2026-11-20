import { z } from "zod";
import { mutation } from "../../init";
import * as stock from "../stock";

/** Place an order */
export const place = mutation({
  input: z.object({ sku: z.string() }),
  handler: async ({ run }, { sku }) => run(stock.reserve, { sku }),
});
