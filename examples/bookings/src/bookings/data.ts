import { and, eq } from "drizzle-orm";
import * as availability from "../availability";
import type { MutationCtx, QueryCtx } from "../logic";
import type { Actor } from "../scope";
import { bookings } from "./schema";

type Row = typeof bookings.$inferSelect;

/** Every read goes through the account: another account's booking is "not found", never "forbidden". */
export async function findBooking(ctx: QueryCtx, id: string) {
  const [b] = await ctx.db.select().from(bookings).where(and(eq(bookings.accountId, ctx.scope.accountId), eq(bookings.id, id)));
  if (!b) throw ctx.errors.notFound(); // "bookings.not_found"
  return b;
}

export async function setStatus({ db, scope }: MutationCtx, id: string, status: Row["status"]) {
  const [b] = await db
    .update(bookings)
    .set({ status })
    .where(and(eq(bookings.accountId, scope.accountId), eq(bookings.id, id)))
    .returning();
  return b!;
}

/** Load, hold the dates, mark it confirmed. Staff confirming and a guest paying both go through here; each emits. */
export async function confirmBooking(ctx: MutationCtx, id: string) {
  const b = await findBooking(ctx, id);
  if (b.status !== "pending") throw ctx.errors.reject("not_pending", { status: b.status });
  await ctx.run(availability.hold, {
    propertyId: b.propertyId, from: b.checkIn, to: b.checkOut, reason: "booking", sourceId: b.id,
  });
  return setStatus(ctx, b.id, "confirmed");
}

/** A rule about one booking, so it runs after loading it. Owners may drop a pending request; a confirmed stay needs an agent. */
export const canCancel = (actor: Actor, b: Row) =>
  actor.role === "agent" || actor.role === "admin" || (actor.role === "owner" && b.status === "pending");
