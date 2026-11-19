import { and, eq } from "drizzle-orm";
import type { MutationCtx, QueryCtx, SignedIn, User } from "../logic";
import { orders } from "./schema";

type Order = typeof orders.$inferSelect;

/** Customers see their own orders, staff see all. */
const visibleTo = (user: User) => (user.role === "staff" ? undefined : eq(orders.customerId, user.id));

/** Someone else's order is "not found", never "forbidden": it doesn't exist for you. */
export async function findOrder(ctx: QueryCtx<SignedIn>, id: string) {
  const [order] = await ctx.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), visibleTo(ctx.scope.user)));
  if (!order) throw ctx.errors.notFound(); // "orders.not_found"
  return order;
}

/** Moves an order on, only if nobody changed it since it was read: of two cancels at once, one wins. */
export async function setStatus(ctx: MutationCtx<SignedIn>, order: Order, status: Order["status"]) {
  const [updated] = await ctx.db
    .update(orders)
    .set({ status })
    .where(and(eq(orders.id, order.id), eq(orders.status, order.status), visibleTo(ctx.scope.user)))
    .returning();
  if (!updated) throw ctx.errors.conflict("changed"); // "orders.changed": the loser rolls back, stock included
  return updated;
}

/** Customers can cancel until it ships. Staff can cancel a shipped order too (a return). */
export const canCancel = (user: User, order: Order) =>
  order.status === "placed" || (order.status === "shipped" && user.role === "staff");
