import { z } from "zod";
import { query } from "../logic";
import { staff } from "../policies";
import { findBooking } from "./data";
import { Booking } from "./schema";

/** Get a booking */
export const get = query({
  input: z.object({ bookingId: z.uuid() }),
  authorize: staff,
  output: Booking,
  handler: (ctx, input) => findBooking(ctx, input.bookingId),
});
