import { z } from "zod";
import { event } from "../logic";

export const confirmed = event({
  description: "A booking was confirmed and its dates are held",
  payload: z.object({ bookingId: z.uuid(), enquiryId: z.uuid().nullable(), guestEmail: z.email() }),
});

export const cancelled = event({
  payload: z.object({ bookingId: z.uuid() }),
});
