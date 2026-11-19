import { z } from "zod";
import { action } from "../logic";
import { get } from "./queries";
import { confirm } from "./mutations";
import { Booking } from "./schema";

/**
 * Charge, then confirm. An action because it talks to a payment provider:
 * no transaction is held open during the network call.
 */
export const checkout = action({
  description: "Charge the guest and confirm the booking; refunds if confirming fails",
  inputSchema: z.object({ bookingId: z.uuid() }),
  expose: "public",
  outputSchema: z.object({ booking: Booking, chargeId: z.string() }),
  async execute({ bookingId }, { services, with: as }) {
    const system = as({ actor: { id: "system", role: "admin" } });
    const booking = await system.run(get, { bookingId });
    const { chargeId } = await services.payments.charge({ amount: booking.total, reference: bookingId });
    try {
      return { booking: await system.run(confirm, { bookingId }), chargeId };
    } catch (e) {
      await services.payments.refund(chargeId);
      throw e;
    }
  },
});
