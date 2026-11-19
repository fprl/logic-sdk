import { on } from "../logic";
import * as bookings from "../bookings";
import { create } from "./mutations";

export const prepareStay = on(() => bookings.confirmed, async ({ bookingId, guestEmail }, { run, services, scope }) => {
  await run(create, { title: "Prepare keys", bookingId });
  await services.mailer.send({ to: guestEmail, subject: "Your booking is confirmed", locale: scope.locale });
});
