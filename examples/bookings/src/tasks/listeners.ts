import { on } from "../logic";
import * as bookings from "../bookings";
import { create } from "./mutations";

export const prepareStay = on(() => bookings.confirmed, async (ctx, payload) => {
  const { bookingId, guestEmail } = payload;
  await ctx.run(create, { title: "Prepare keys", bookingId });
  await ctx.services.mailer.send({ to: guestEmail, subject: "Your booking is confirmed", locale: ctx.scope.locale });
});
