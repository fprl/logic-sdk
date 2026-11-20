import { on } from "../logic";
import * as bookings from "../bookings";
import { markWon } from "./mutations";

/** Enquiries owns this rule. Bookings doesn't know enquiries exist. */
export const winOnBooking = on(() => bookings.confirmed, async (ctx, payload) => {
  if (payload.enquiryId) await ctx.run(markWon, { enquiryId: payload.enquiryId });
});
