import { z } from "zod";
import * as catalog from "../catalog";
import { mutation } from "../logic";
import { signedIn, staff } from "../policies";
import { canCancel, findOrder, setStatus } from "./data";
import { placed } from "./events";
import { Order, orders } from "./schema";

/** Order some products. Prices come from the catalog, never from the client. */
export const place = mutation({
  input: z.object({
    items: z.array(z.object({ sku: z.string(), quantity: z.int().min(1) })).min(1),
  }),
  authorize: signedIn,
  expose: true,
  output: Order,
  async handler(ctx, input) {
    const { maxItems } = ctx.config.orders;
    const count = input.items.reduce((sum, item) => sum + item.quantity, 0);
    if (count > maxItems) throw ctx.errors.reject("too_many_items", { max: maxItems }); // "orders.too_many_items"

    // Same transaction: if anything below fails, the stock comes back
    const lines = await ctx.run(catalog.reserve, { items: input.items });
    const total = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);

    const [order] = await ctx.db
      .insert(orders)
      .values({ customerId: ctx.scope.user.id, items: lines, total, createdAt: ctx.now() })
      .returning();

    ctx.emit(placed, { orderId: order!.id, customerId: order!.customerId, total });
    return order!;
  },
});

/** Cancel an order and put its items back in stock */
export const cancel = mutation({
  input: z.object({ orderId: z.uuid() }),
  authorize: signedIn,
  expose: true,
  output: Order,
  async handler(ctx, input) {
    const order = await findOrder(ctx, input.orderId);
    if (order.status === "cancelled") throw ctx.errors.reject("already_cancelled");
    if (!canCancel(ctx.scope.user, order)) throw ctx.errors.deny();

    const cancelled = await setStatus(ctx, order, "cancelled");
    await ctx.run(catalog.release, { items: order.items });
    return cancelled;
  },
});

/** Mark an order as shipped */
export const ship = mutation({
  input: z.object({ orderId: z.uuid() }),
  authorize: staff,
  expose: true,
  output: Order,
  async handler(ctx, input) {
    const order = await findOrder(ctx, input.orderId);
    if (order.status !== "placed") throw ctx.errors.reject("not_placed", { status: order.status });
    return setStatus(ctx, order, "shipped");
  },
});
