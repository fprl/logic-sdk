import type { Actor, Ctx, Order } from "../init";

/** Record checks: sync, named can*, over a loaded record. */
export const canCancel = (actor: Actor, order: Order) => order.ownerId === actor.id && order.status === "placed";
export function canRefund(actor: Actor | null, order: Order) {
  return actor?.id === order.ownerId;
}

export function findOrder(ctx: Ctx, id: string): Order {
  const order = ctx.db.rows.find((o) => o.id === id);
  if (!order) throw ctx.errors.notFound();
  return order;
}

/** Loads the order and applies the record check: show orders.cancel lists canCancel through this helper. */
export function loadForCancel(ctx: Ctx, actor: Actor, id: string): Order {
  const order = findOrder(ctx, id);
  if (!canCancel(actor, order)) throw ctx.errors.deny();
  return order;
}
