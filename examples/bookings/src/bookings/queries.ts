import { z } from "zod";
import { query } from "../logic";
import { staff } from "../policies";
import { findBooking } from "./data";
import { Booking } from "./schema";

export const get = query({
  description: "Get a booking",
  input: z.object({ bookingId: z.uuid() }),
  authorize: staff,
  expose: true,
  output: Booking,
  handler: (ctx, input) => findBooking(ctx, input.bookingId),
});

/** Internal: what `checkout` charges. Guests can't `get` a booking, so the action reads only this. */
export const amountDue = query({
  description: "What the guest owes for a pending booking",
  input: z.object({ bookingId: z.uuid() }),
  async handler(ctx, input) {
    const b = await findBooking(ctx, input.bookingId);
    if (b.status !== "pending") throw ctx.errors.reject("not_pending", { status: b.status });
    return { total: b.total };
  },
});
