import { eq } from "drizzle-orm";
import type { Caller } from "logic-sdk";
import { toFetchHandler } from "logic-sdk/fetch";
import { expect, test } from "vitest";
import * as availability from "../src/availability";
import * as bookings from "../src/bookings";
import * as enquiries from "../src/enquiries";
import * as pricing from "../src/pricing";
import * as properties from "../src/properties";
import * as tasks from "../src/tasks";
import { holds } from "../src/availability/schema";
import { enquiries as enquiriesTable } from "../src/enquiries/schema";
import type { Scope } from "../src/scope";
import { scopeAs, setup, withServices } from "./setup";

const { registry } = await setup();

async function seedProperty(app: Caller<Scope>) {
  return app.with({ actor: { id: "owner_1", role: "owner" } }).run(properties.create, {
    name: "Casa Azul", nightlyRate: 120_00, cleaningFee: 60_00, minNights: 2,
  });
}

test("owners create properties; guests can't", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const p = await seedProperty(tx.as(scopeAs("owner")));
    expect(p.name).toEqual("Casa Azul");
    await expect(tx.as(scopeAs("guest")).run(properties.create, { name: "x", nightlyRate: 1, cleaningFee: 0 })).rejects.toMatchObject({ kind: "forbidden" });
  });
});

test("pricing: nights × rate + cleaning, with a minimum stay", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const app = tx.as(scopeAs(null));
    const p = await seedProperty(app);
    expect(await app.run(pricing.priceStay, { propertyId: p.id, from: "2026-07-01", to: "2026-07-04" })).toEqual({ nights: 3, nightly: 120_00, cleaning: 60_00, total: 420_00 });
    await expect(app.run(pricing.priceStay, { propertyId: p.id, from: "2026-07-01", to: "2026-07-02" })).rejects.toMatchObject({ code: "pricing.min_nights" });
  });
});

test("enquiry → request → confirm: dates held, enquiry won, task created, guest emailed", async () => {
  const { t, mailer } = withServices(registry);
  await t.transaction(async (tx) => {
    const guest = tx.as(scopeAs(null, "acc_1", "es"));
    const agent = tx.as(scopeAs("agent", "acc_1", "en"));
    const p = await seedProperty(guest);

    const enquiry = await guest.run(enquiries.create, { propertyId: p.id, guestEmail: "ana@x.com", message: "¿Libre en julio?" });
    const b = await guest.run(bookings.request, {
      propertyId: p.id, checkIn: "2026-07-01", checkOut: "2026-07-05", guestEmail: "ana@x.com", enquiryId: enquiry.id,
    });
    expect([b.status, b.total]).toEqual(["pending", 540_00]);

    const confirmed = await agent.run(bookings.confirm, { bookingId: b.id });
    expect(confirmed.status).toEqual("confirmed");

    expect((await tx.db.select().from(holds).where(eq(holds.propertyId, p.id))).map((h: any) => [h.from, h.to, h.reason, h.sourceId])).toEqual([["2026-07-01", "2026-07-05", "booking", b.id]]);
    expect((await tx.db.select().from(enquiriesTable).where(eq(enquiriesTable.id, enquiry.id)))[0].status).toEqual("won");
    expect((await agent.run(tasks.list, undefined)).filter((x) => x.bookingId === b.id).map((x) => x.title)).toEqual(["Prepare keys"]);
    expect(mailer.sent).toEqual([{ to: "ana@x.com", subject: "Your booking is confirmed", locale: "en" }]);
    expect(tx.events.map((e) => e.name)).toEqual(["bookings.confirmed"]);
  });
});

test("double booking: the second confirm fails and rolls back completely", async () => {
  const { t, mailer } = withServices(registry);
  await t.transaction(async (tx) => {
    const guest = tx.as(scopeAs(null));
    const agent = tx.as(scopeAs("agent"));
    const p = await seedProperty(guest);
    const req = (checkIn: string, checkOut: string, email: string) =>
      guest.run(bookings.request, { propertyId: p.id, checkIn, checkOut, guestEmail: email });

    const a = await req("2026-08-01", "2026-08-05", "a@x.com");
    const b = await req("2026-08-03", "2026-08-07", "b@x.com"); // both pending: nothing held yet
    await agent.run(bookings.confirm, { bookingId: a.id });
    await expect(agent.run(bookings.confirm, { bookingId: b.id })).rejects.toMatchObject({ code: "availability.dates_unavailable" });

    expect((await agent.run(bookings.get, { bookingId: b.id })).status).toEqual("pending");
    expect((await tx.db.select().from(holds).where(eq(holds.propertyId, p.id))).length).toEqual(1);
    expect(mailer.sent.map((m) => m.to)).toEqual(["a@x.com"]);
    // requesting overlapping dates now fails up front
    await expect(req("2026-08-04", "2026-08-06", "c@x.com")).rejects.toMatchObject({ kind: "conflict", code: "bookings.dates_unavailable" });
  });
});

test("back-to-back stays: check-out day is free for the next check-in", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const guest = tx.as(scopeAs(null));
    const agent = tx.as(scopeAs("agent"));
    const p = await seedProperty(guest);
    for (const [i, o] of [["2026-09-01", "2026-09-04"], ["2026-09-04", "2026-09-06"]] as const) {
      const b = await guest.run(bookings.request, { propertyId: p.id, checkIn: i, checkOut: o, guestEmail: "g@x.com" });
      await agent.run(bookings.confirm, { bookingId: b.id });
    }
    expect((await tx.db.select().from(holds).where(eq(holds.propertyId, p.id))).length).toEqual(2);
  });
});

test("the database constraint is the real guarantee against overlaps", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const p = await seedProperty(tx.as(scopeAs("owner")));
    await tx.db.insert(holds).values({ propertyId: p.id, from: "2026-10-01", to: "2026-10-05", reason: "booking", sourceId: "x" });
    let code = "";
    try {
      await tx.db.transaction((sp: any) => sp.insert(holds).values({ propertyId: p.id, from: "2026-10-03", to: "2026-10-04", reason: "booking", sourceId: "y" }));
    } catch (e: any) { code = e.code ?? e.cause?.code; }
    expect(code).toEqual("23P01");
  });
});

test("cancel releases the dates", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const guest = tx.as(scopeAs(null));
    const agent = tx.as(scopeAs("agent"));
    const p = await seedProperty(guest);
    const range = { propertyId: p.id, from: "2026-07-10", to: "2026-07-12" };
    const b = await guest.run(bookings.request, { propertyId: p.id, checkIn: range.from, checkOut: range.to, guestEmail: "g@x.com" });
    await agent.run(bookings.confirm, { bookingId: b.id });
    expect((await guest.run(availability.check, range)).available).toEqual(false);
    await agent.run(bookings.cancel, { bookingId: b.id });
    expect((await guest.run(availability.check, range)).available).toEqual(true);
    await expect(agent.run(bookings.cancel, { bookingId: b.id })).rejects.toMatchObject({ code: "bookings.already_cancelled" });
  });
});

test("record rule: owners may drop a pending request, but a confirmed stay needs an agent", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const guest = tx.as(scopeAs(null));
    const owner = tx.as(scopeAs("owner"));
    const p = await seedProperty(guest);
    const req = (checkIn: string, checkOut: string) => guest.run(bookings.request, { propertyId: p.id, checkIn, checkOut, guestEmail: "g@x.com" });

    const pending = await req("2026-11-01", "2026-11-03");
    expect((await owner.run(bookings.cancel, { bookingId: pending.id })).status).toEqual("cancelled");

    const stay = await req("2026-11-10", "2026-11-12");
    await tx.as(scopeAs("agent")).run(bookings.confirm, { bookingId: stay.id });
    await expect(owner.run(bookings.cancel, { bookingId: stay.id })).rejects.toMatchObject({ kind: "forbidden", code: "bookings.cancel.forbidden" });
    // the policy (staff) runs first: a guest never reaches the record rule
    await expect(guest.run(bookings.cancel, { bookingId: stay.id })).rejects.toMatchObject({ kind: "forbidden" });
  });
});

test("owner blocks go through availability's rules", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const owner = tx.as(scopeAs("owner"));
    const guest = tx.as(scopeAs(null));
    const p = await seedProperty(owner);
    await owner.run(availability.block, { propertyId: p.id, from: "2026-12-20", to: "2026-12-27", reason: "owner_block" });
    await expect(guest.run(bookings.request, { propertyId: p.id, checkIn: "2026-12-24", checkOut: "2026-12-26", guestEmail: "g@x.com" })).rejects.toMatchObject({ kind: "conflict", code: "bookings.dates_unavailable" });
    await expect(guest.run(availability.block, { propertyId: p.id, from: "2026-01-01", to: "2026-01-02", reason: "maintenance" })).rejects.toMatchObject({ kind: "forbidden" });
  });
});

test("checkout action: charges, confirms, refunds when confirming fails", async () => {
  const { t, payments } = withServices(registry);
  await t.transaction(async (tx) => {
    const guest = tx.as(scopeAs("guest"));
    const p = await seedProperty(guest);
    const b = await guest.run(bookings.request, { propertyId: p.id, checkIn: "2026-07-20", checkOut: "2026-07-23", guestEmail: "g@x.com" });
    const out = await guest.run(bookings.checkout, { bookingId: b.id });
    expect([out.booking.status, out.chargeId]).toEqual(["confirmed", "ch_1"]);
    expect(payments.charges.get("ch_1")).toEqual({ amount: 420_00, refunded: false });

    const b2 = await guest.run(bookings.request, { propertyId: p.id, checkIn: "2026-07-26", checkOut: "2026-07-29", guestEmail: "h@x.com" });
    tx.stub(availability.hold, async () => { throw new Error("calendar service down"); });
    await expect(guest.run(bookings.checkout, { bookingId: b2.id })).rejects.toThrow(/calendar service down/);
    expect(payments.charges.get("ch_2")).toEqual({ amount: 420_00, refunded: true });
    expect((await tx.as(scopeAs("agent")).run(bookings.get, { bookingId: b2.id })).status).toEqual("pending");

    // no forged admin: the guest can pay, but still can't read or confirm bookings directly
    await expect(guest.run(bookings.get, { bookingId: b.id })).rejects.toMatchObject({ kind: "forbidden" });
    await expect(guest.run(bookings.confirm, { bookingId: b2.id })).rejects.toMatchObject({ kind: "forbidden" });
    // paying for a confirmed booking is refused before any charge
    await expect(guest.run(bookings.checkout, { bookingId: b.id })).rejects.toMatchObject({ code: "bookings.not_pending" });
    expect(payments.charges.size).toEqual(2);
  });
});

test("listeners: false tests bookings without the other modules reacting", async () => {
  const { t, mailer } = withServices(registry, { listeners: false });
  await t.transaction(async (tx) => {
    const guest = tx.as(scopeAs(null));
    const p = await seedProperty(guest);
    const b = await guest.run(bookings.request, { propertyId: p.id, checkIn: "2026-07-01", checkOut: "2026-07-03", guestEmail: "g@x.com" });
    await tx.as(scopeAs("agent")).run(bookings.confirm, { bookingId: b.id });
    expect(tx.events.map((e) => e.name)).toEqual(["bookings.confirmed"]);
    expect(mailer.sent).toEqual([]);
  });
});

test("tenancy: another account can't see the booking", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const guest = tx.as(scopeAs(null, "acc_1"));
    const p = await seedProperty(guest);
    const b = await guest.run(bookings.request, { propertyId: p.id, checkIn: "2026-07-01", checkOut: "2026-07-03", guestEmail: "g@x.com" });
    await expect(tx.as(scopeAs("agent", "acc_2")).run(bookings.confirm, { bookingId: b.id })).rejects.toMatchObject({ code: "bookings.not_found" });
  });
});

test("fetch adapter: only exposed functions are published, errors map to statuses", async () => {
  await withServices(registry).t.transaction(async (tx) => {
    const p = await seedProperty(tx.as(scopeAs("owner")));
    const handler = toFetchHandler(tx.registry, {
      basePath: "/api/",
      resolveScope: (req) => scopeAs((req.headers.get("x-role") as any) ?? null),
    });
    const call = async (id: string, body: unknown, role?: string, method = "POST") => {
      const res = await handler(new Request(`http://x/api/${id}`, {
        method, body: method === "POST" ? JSON.stringify(body) : undefined,
        headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(role ? { "x-role": role } : {}) },
      }));
      return [res.status, await res.json()] as const;
    };

    // internal functions don't exist over HTTP, and there's no listing of what does
    expect((await call("enquiries.markWon", {}))[0]).toEqual(404);
    expect((await call("bookings.confirmPaid", {}))[0]).toEqual(404);
    expect((await handler(new Request("http://x/api/"))).status).toEqual(404);

    const [s1, r1] = await call("bookings.request", { propertyId: p.id, checkIn: "2026-07-01", checkOut: "2026-07-04", guestEmail: "g@x.com" });
    expect(s1).toEqual(200);
    const bookingId = (r1 as any).data.id;
    expect((await call("bookings.confirm", { bookingId }))[0]).toEqual(403);
    expect((await call("bookings.confirm", { bookingId }, "agent"))[0]).toEqual(200);
    expect(await call("bookings.confirm", { bookingId }, "agent")).toEqual([422, { error: { kind: "rejected", code: "bookings.not_pending", details: { status: "confirmed" } } }]);
    expect((await call("availability.hold", {}))[0]).toEqual(404);
    expect((await call("bookings.request", { propertyId: "nope" }))[0]).toEqual(400);
    // CSRF guard: a form post (no JSON content type) is refused
    expect((await handler(new Request("http://x/api/bookings.confirm", { method: "POST", body: "bookingId=x", headers: { "content-type": "application/x-www-form-urlencoded", "x-role": "agent" } }))).status).toEqual(415);
    const del = await handler(new Request("http://x/api/bookings.confirm", { method: "DELETE" }));
    expect([del.status, del.headers.get("allow")]).toEqual([405, "POST"]);
    // basePath without a trailing slash works too
    const noSlash = toFetchHandler(tx.registry, { basePath: "/api", resolveScope: () => scopeAs(null) });
    const check = `/api/availability.check?input=${encodeURIComponent(JSON.stringify({ propertyId: p.id, from: "2026-07-02", to: "2026-07-03" }))}`;
    expect(await (await noSlash(new Request(`http://x${check}`))).json()).toEqual({ data: { available: false } });
  });
});
