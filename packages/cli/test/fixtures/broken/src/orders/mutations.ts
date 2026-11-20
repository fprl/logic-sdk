import { z } from "zod";
import { event, mutation } from "../init";
import * as stock from "../stock";
import { reserved } from "../stock/data"; // ✗ another module's internal file

export const shipped = event({ payload: z.object({ id: z.string() }) });

export const place = mutation({
  description: "Place an order",
  input: z.object({ sku: z.string() }),
  async handler({ run }, { sku }) {
    await fetch("https://payments.example.com"); // ✗ network inside a transaction
    void reserved;
    return run(stock.reserve, { sku, at: new Date().toISOString() }); // ! wall clock
  },
});

export const refund = mutation({
  description: "Refund an order",
  input: z.object({ id: z.string() }),
  handler: async (_, { id }) => ({ id }),
});
