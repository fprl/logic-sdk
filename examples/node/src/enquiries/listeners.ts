import { on } from "../logic";
import * as bookings from "../bookings";
import { markWon } from "./mutations";

/** Enquiries owns this rule. Bookings doesn't know enquiries exist. */
export const winOnBooking = on(() => bookings.confirmed, async ({ enquiryId }, { run }) => {
  if (enquiryId) await run(markWon, { enquiryId });
});
