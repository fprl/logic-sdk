import { z } from "zod";
import { event, defineMutation } from "../init";
import * as stock from "../stock";
import { reserved } from "../stock/data"; // ✗ another module's internal file

export const shipped = event({ payload: z.object({ id: z.string() }) });

/** Place an order */
export const place = defineMutation({
  input: z.object({ sku: z.string() }),
  async handler({ run }, { sku }) {
    await fetch("https://payments.example.com"); // ✗ network inside a transaction
    void reserved;
    return run(stock.reserve, { sku, at: new Date().toISOString() }); // ! wall clock
  },
});

/** Refund an order */
export const refund = defineMutation({
  input: z.object({ id: z.string() }),
  handler: async (_, { id }) => ({ id }),
});
