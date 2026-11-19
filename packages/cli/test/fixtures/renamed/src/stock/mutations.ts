import { z } from "zod";
import { defineMutation } from "../init";
import * as orders from "../orders";

export const reserve = defineMutation({
  description: "Reserve stock",
  inputSchema: z.object({ sku: z.string(), at: z.string() }),
  async execute({ sku }, { run }) {
    await run(orders.refund, { id: sku }); // ✗ stock → orders, while orders → stock: a cycle
    return { sku };
  },
});
