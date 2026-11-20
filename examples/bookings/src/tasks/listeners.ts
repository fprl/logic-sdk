import { listener } from "../logic";
import * as bookings from "../bookings";
import { create } from "./mutations";

/** Create the key-handover task and email the guest in their language */
export const prepareStay = listener({
  event: () => bookings.confirmed,
  async handler(ctx, payload) {
    const { bookingId, guestEmail } = payload;
    await ctx.run(create, { title: "Prepare keys", bookingId });
    await ctx.services.mailer.send({ to: guestEmail, subject: "Your booking is confirmed", locale: ctx.scope.locale });
  },
});
