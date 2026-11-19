import { z } from "zod";
import { mutation } from "../../init";
import * as stock from "../stock";

export const place = mutation({
  description: "Place an order",
  inputSchema: z.object({ sku: z.string() }),
  execute: async ({ sku }, { run }) => run(stock.reserve, { sku }),
});
