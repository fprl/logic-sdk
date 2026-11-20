import { listener } from "../logic";
import * as bookings from "../bookings";
import { markWon } from "./mutations";

/** Enquiries owns this rule. Bookings doesn't know enquiries exist. */
export const winOnBooking = listener({
  event: () => bookings.confirmed,
  description: "Mark the enquiry won when its booking is confirmed",
  async handler(ctx, payload) {
    if (payload.enquiryId) await ctx.run(markWon, { enquiryId: payload.enquiryId });
  },
});
