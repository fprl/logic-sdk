import { z } from "zod";
import { event } from "../logic";

/** A booking was confirmed and its dates are held */
export const confirmed = event({
  payload: z.object({ bookingId: z.uuid(), enquiryId: z.uuid().nullable(), guestEmail: z.email() }),
});

export const cancelled = event({
  payload: z.object({ bookingId: z.uuid() }),
});
