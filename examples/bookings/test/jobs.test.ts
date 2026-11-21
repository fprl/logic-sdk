import { expect, test } from "vitest";
import * as bookings from "../src/bookings";
import * as properties from "../src/properties";
import * as tasks from "../src/tasks";
import { scopeAs, testRegistry } from "./setup";

// Manual: jobs wait until the test runs them, like Oban's `testing: :manual`.
const { t, mailer } = await testRegistry({ jobs: "manual" });

async function confirmedBooking() {
  const owner = t.as(scopeAs("owner"));
  const p = await owner.run(properties.create, { name: "Casa Azul", nightlyRate: 120_00, cleaningFee: 60_00, minNights: 2 });
  const b = await t.as(scopeAs(null)).run(bookings.request, { propertyId: p.id, checkIn: "2026-07-01", checkOut: "2026-07-03", guestEmail: "g@x.com" });
  return t.as(scopeAs("agent", "acc_1", "en")).run(bookings.confirm, { bookingId: b.id });
}

test("confirming queues the other modules' work without running it", async () => {
  await confirmedBooking();
  expect(t.events.map((e) => e.name)).toEqual(["bookings.confirmed"]);
  expect(t.jobs.queued.map((j) => j.listener).sort()).toEqual(["enquiries.winOnBooking", "tasks.prepareStay"]);
  expect(mailer.sent).toEqual([]);
});

test("drain runs what's queued", async () => {
  await confirmedBooking();
  await t.jobs.drain();
  expect(mailer.sent).toEqual([{ to: "g@x.com", subject: "Your booking is confirmed", locale: "en" }]);
  expect(t.jobs.queued).toEqual([]);
});

test("perform runs one listener by hand", async () => {
  const booking = await confirmedBooking();
  const payload = { bookingId: booking.id, enquiryId: null, guestEmail: "g@x.com" };
  await t.jobs.perform(tasks.prepareStay, payload, { scope: scopeAs("agent", "acc_1", "es") });
  expect(mailer.sent).toEqual([{ to: "g@x.com", subject: "Your booking is confirmed", locale: "es" }]);
});
