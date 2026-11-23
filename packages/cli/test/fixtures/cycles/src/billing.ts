// Writes in a circle with bookings: confirm → charge → markPaid.
import { z } from "zod";
import * as bookings from "./bookings";
import { mutation } from "./init";

export const charge = mutation({
  input: z.object({ bookingId: z.string() }),
  handler: async ({ run }, { bookingId }) => run(bookings.markPaid, { bookingId }),
});
