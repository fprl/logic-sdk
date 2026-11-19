import { z } from "zod";
import { query } from "../logic";
import { findBooking } from "./data";
import { Booking } from "./schema";

export const get = query({
  description: "Get a booking",
  inputSchema: z.object({ bookingId: z.uuid() }),
  expose: "staff",
  outputSchema: Booking,
  execute: ({ bookingId }, ctx) => findBooking(ctx, bookingId),
});
