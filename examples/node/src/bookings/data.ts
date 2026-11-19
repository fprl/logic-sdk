import { and, eq } from "drizzle-orm";
import type { MutationCtx, QueryCtx } from "../logic";
import { bookings } from "./schema";

export async function findBooking(ctx: QueryCtx, id: string) {
  const [b] = await ctx.db.select().from(bookings).where(and(eq(bookings.accountId, ctx.scope.accountId), eq(bookings.id, id)));
  if (!b) throw ctx.notFound(); // "bookings.not_found"
  return b;
}

export async function setStatus({ db, scope }: MutationCtx, id: string, status: "pending" | "confirmed" | "cancelled") {
  const [b] = await db
    .update(bookings)
    .set({ status })
    .where(and(eq(bookings.accountId, scope.accountId), eq(bookings.id, id)))
    .returning();
  return b!;
}
