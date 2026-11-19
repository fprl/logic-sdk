import { z } from "zod";
import { mutation } from "../logic";
import * as availability from "../availability";
import * as pricing from "../pricing";
import { findBooking, setStatus } from "./data";
import { cancelled, confirmed } from "./events";
import { Booking, bookings } from "./schema";

export const request = mutation({
  description: "Request a booking. Prices it and checks the dates are free; nothing is held yet.",
  inputSchema: z.object({
    propertyId: z.uuid(),
    checkIn: z.iso.date(),
    checkOut: z.iso.date(),
    guestEmail: z.email(),
    enquiryId: z.uuid().optional(),
  }),
  expose: "public",
  outputSchema: Booking,
  async execute(input, { db, scope, run, conflict }) {
    const range = { propertyId: input.propertyId, from: input.checkIn, to: input.checkOut };
    const { available } = await run(availability.check, range);
    if (!available) throw conflict("dates_unavailable"); // "bookings.dates_unavailable": our code, our module
    const price = await run(pricing.priceStay, range);

    const [b] = await db
      .insert(bookings)
      .values({ ...input, enquiryId: input.enquiryId ?? null, accountId: scope.accountId, total: price.total })
      .returning();
    return b!;
  },
});

export const confirm = mutation({
  description: "Confirm a pending booking: holds its dates and tells the other modules",
  inputSchema: z.object({ bookingId: z.uuid() }),
  expose: "staff",
  outputSchema: Booking,
  async execute({ bookingId }, ctx) {
    const { run, emit } = ctx;
    const b = await findBooking(ctx, bookingId);
    if (b.status !== "pending") throw ctx.reject("not_pending", { status: b.status });

    await run(availability.hold, {
      propertyId: b.propertyId, from: b.checkIn, to: b.checkOut, reason: "booking", sourceId: b.id,
    });
    const updated = await setStatus(ctx, b.id, "confirmed");

    emit(confirmed, { bookingId: b.id, enquiryId: b.enquiryId, guestEmail: b.guestEmail });
    return updated;
  },
});

export const cancel = mutation({
  description: "Cancel a booking and free its dates",
  inputSchema: z.object({ bookingId: z.uuid() }),
  expose: "staff",
  outputSchema: Booking,
  async execute({ bookingId }, ctx) {
    const { run, emit } = ctx;
    const b = await findBooking(ctx, bookingId);
    if (b.status === "cancelled") throw ctx.reject("already_cancelled");
    await run(availability.release, { sourceId: b.id });
    const updated = await setStatus(ctx, b.id, "cancelled");
    emit(cancelled, { bookingId: b.id });
    return updated;
  },
});
