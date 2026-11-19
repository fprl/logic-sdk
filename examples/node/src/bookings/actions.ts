import { z } from "zod";
import { action } from "../logic";
import { anyone } from "../policies";
import { amountDue } from "./queries";
import { confirmPaid } from "./mutations";
import { Booking } from "./schema";

/**
 * Charge, then confirm. An action because it talks to a payment provider:
 * no transaction is held open during the network call.
 *
 * A guest may pay for a booking but may not read or confirm bookings in general. So this stays thin and
 * runs two internal functions (`amountDue`, `confirmPaid`) that have no policy of their own: nobody
 * pretends to be an admin, and the scope (account, locale) is still the guest's.
 */
export const checkout = action({
  description: "Charge the guest and confirm the booking; refunds if confirming fails",
  inputSchema: z.object({ bookingId: z.uuid() }),
  authorize: anyone,
  expose: true,
  outputSchema: z.object({ booking: Booking, chargeId: z.string() }),
  async execute({ bookingId }, { run, services }) {
    const { total } = await run(amountDue, { bookingId });
    const { chargeId } = await services.payments.charge({ amount: total, reference: bookingId });
    try {
      return { booking: await run(confirmPaid, { bookingId }), chargeId };
    } catch (e) {
      await services.payments.refund(chargeId);
      throw e;
    }
  },
});
