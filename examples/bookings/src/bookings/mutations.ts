import { z } from "zod";
import { mutation } from "../logic";
import { anyone, staff } from "../policies";
import * as availability from "../availability";
import * as pricing from "../pricing";
import { canCancel, confirmBooking, findBooking, setStatus } from "./data";
import { cancelled, confirmed } from "./events";
import { Booking, bookings } from "./schema";

/** Request a booking. Prices it and checks the dates are free; nothing is held yet. */
export const request = mutation({
  input: z.object({
    propertyId: z.uuid(),
    checkIn: z.iso.date(),
    checkOut: z.iso.date(),
    guestEmail: z.email(),
    enquiryId: z.uuid().optional(),
  }),
  authorize: anyone,
  output: Booking,
  async handler(ctx, input) {
    const range = { propertyId: input.propertyId, from: input.checkIn, to: input.checkOut };
    const { available } = await ctx.run(availability.check, range);
    if (!available) throw ctx.errors.conflict("dates_unavailable"); // "bookings.dates_unavailable": our code, our module
    const price = await ctx.run(pricing.priceStay, range);

    const [b] = await ctx.db
      .insert(bookings)
      .values({ ...input, enquiryId: input.enquiryId ?? null, accountId: ctx.scope.accountId, total: price.total })
      .returning();
    return b!;
  },
});

/** Confirm a pending booking: holds its dates and tells the other modules */
export const confirm = mutation({
  input: z.object({ bookingId: z.uuid() }),
  authorize: staff,
  output: Booking,
  async handler(ctx, input) {
    const b = await confirmBooking(ctx, input.bookingId);
    ctx.emit(confirmed, { bookingId: b.id, enquiryId: b.enquiryId, guestEmail: b.guestEmail });
    return b;
  },
});

/**
 * Confirm a booking the guest has just paid for
 *
 * Internal (no authorize, not in src/rpc.ts): `checkout` runs it once the guest has paid. Not reachable from
 * any adapter, so the gate is the action that runs it.
 */
export const confirmPaid = mutation({
  input: z.object({ bookingId: z.uuid() }),
  output: Booking,
  async handler(ctx, input) {
    const b = await confirmBooking(ctx, input.bookingId);
    ctx.emit(confirmed, { bookingId: b.id, enquiryId: b.enquiryId, guestEmail: b.guestEmail });
    return b;
  },
});

/** Cancel a booking and free its dates */
export const cancel = mutation({
  input: z.object({ bookingId: z.uuid() }),
  authorize: staff,
  output: Booking,
  async handler(ctx, input) {
    const b = await findBooking(ctx, input.bookingId);
    if (!canCancel(ctx.scope.actor, b)) throw ctx.errors.deny(); // "bookings.cancel.forbidden"
    if (b.status === "cancelled") throw ctx.errors.reject("already_cancelled");
    await ctx.run(availability.release, { sourceId: b.id });
    const updated = await setStatus(ctx, b.id, "cancelled");
    ctx.emit(cancelled, { bookingId: b.id });
    return updated;
  },
});
