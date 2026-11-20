import { z } from "zod";
import { mutation } from "../init";
import * as orders from "../orders";

export const reserve = mutation({
  description: "Reserve stock",
  input: z.object({ sku: z.string(), at: z.string() }),
  async handler({ run }, { sku }) {
    await run(orders.refund, { id: sku }); // ✗ stock → orders, while orders → stock: a cycle
    return { sku };
  },
});
