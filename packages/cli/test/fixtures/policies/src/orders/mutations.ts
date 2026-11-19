import { z } from "zod";
import { member, mutation } from "../init";
import * as stock from "../stock";
import { canRefund, findOrder, loadForCancel } from "./data";

const Order = z.object({ id: z.string(), status: z.string() });

export const cancel = mutation({
  description: "Cancel an order",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: Order,
  authorize: member,
  expose: true,
  async execute({ id }, ctx) {
    const order = loadForCancel(ctx, ctx.scope.actor, id);
    ctx.db.run("update orders"); // a database call, not a run edge
    await ctx.run(stock.release, { sku: order.id }, { scope: { accountId: "a1" } }); // acts in another account on purpose
    return order;
  },
});

export const refund = mutation({
  description: "Refund an order",
  inputSchema: z.object({ id: z.string() }),
  authorize: (s) => s.accountId !== "",
  async execute({ id }, ctx) {
    const { run, db, scope, errors } = ctx;
    const order = findOrder(ctx, id);
    if (!canRefund(scope.actor, order)) throw errors.deny();
    db.run("update orders"); // not an edge either
    await run(stock.release, { sku: id });
    return { id };
  },
});
