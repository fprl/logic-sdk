import { listener } from "../logic";
import * as bookings from "../bookings";
import { markWon } from "./mutations";

/**
 * Mark the enquiry won when its booking is confirmed
 *
 * Enquiries owns this rule. Bookings doesn't know enquiries exist.
 */
export const winOnBooking = listener({
  event: () => bookings.confirmed,
  async handler(ctx, payload) {
    if (payload.enquiryId) await ctx.run(markWon, { enquiryId: payload.enquiryId });
  },
});
