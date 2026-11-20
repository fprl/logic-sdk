import { z } from "zod";
import { defineMutation } from "../init";
import * as orders from "../orders";

/** Reserve stock */
export const reserve = defineMutation({
  input: z.object({ sku: z.string(), at: z.string() }),
  async handler({ run }, { sku }) {
    await run(orders.refund, { id: sku }); // ✗ stock → orders, while orders → stock: a cycle
    return { sku };
  },
});
