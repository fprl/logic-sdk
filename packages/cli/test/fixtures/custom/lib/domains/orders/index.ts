import { z } from "zod";
import { mutation } from "../../init";
import * as stock from "../stock";

export const place = mutation({
  description: "Place an order",
  input: z.object({ sku: z.string() }),
  handler: async ({ run }, { sku }) => run(stock.reserve, { sku }),
});
