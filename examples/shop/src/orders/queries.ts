import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { signedIn, staff } from "../policies";
import { canCancel } from "./data";
import { Order, orders } from "./schema";

/** Your own orders, newest first, with what you may do with each */
export const mine = query({
  authorize: signedIn,
  expose: true,
  output: z.array(Order.extend({ can: z.object({ cancel: z.boolean() }) })),
  async handler(ctx) {
    const rows = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.customerId, ctx.scope.user.id))
      .orderBy(desc(orders.createdAt));
    // The same rule cancel checks, so the UI shows the button only when it would work
    return rows.map((order) => ({ ...order, can: { cancel: canCancel(ctx.scope.user, order) } }));
  },
});

/** How many orders wait to ship. Staff only. */
export const toShip = query({
  authorize: staff,
  output: z.number(),
  async handler(ctx) {
    const rows = await ctx.db.select({ id: orders.id }).from(orders).where(eq(orders.status, "placed"));
    return rows.length;
  },
});
