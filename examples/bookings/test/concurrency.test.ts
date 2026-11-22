import { isDomainError } from "logic-sdk";
import { sqlState } from "logic-sdk/drizzle/pg";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as bookings from "../src/bookings";
import * as properties from "../src/properties";
import { holds } from "../src/availability/schema";
import { db } from "../src/db/client";
import { makeRegistry } from "../src/registry";
import { memoryMailer, memoryPayments } from "../src/services";
import { scopeAs } from "./setup";

// PGlite runs one transaction at a time, so it can't race. This needs real Postgres:
// bun run db && bun run test:pg
test.skipIf(!process.env.DATABASE_URL)("agents confirming overlapping bookings at once: one wins, the rest get a clean conflict", async () => {
  const registry = makeRegistry(db, { mailer: memoryMailer(), payments: memoryPayments() });
  const as = (role: Parameters<typeof scopeAs>[0]) => registry.as(scopeAs(role, "acc_race")); // real commits: keep them out of other tests' account
  for (let round = 0; round < 10; round++) {
    const p = await as("owner").run(properties.create, { name: "Race", nightlyRate: 1, cleaningFee: 0, minNights: 1 });
    const reqs = await Promise.all(
      ["2026-07-01/2026-07-05", "2026-07-03/2026-07-07", "2026-07-04/2026-07-06"].map((r, i) => {
        const [checkIn, checkOut] = r.split("/") as [string, string];
        return as(null).run(bookings.request, { propertyId: p.id, checkIn, checkOut, guestEmail: `g${i}@x.com` });
      }),
    );
    const agent = as("agent");
    const outcomes = await Promise.allSettled(reqs.map((b) => agent.run(bookings.confirm, { bookingId: b.id })));
    const results = outcomes.map((o) =>
      o.status === "fulfilled" ? "won" : isDomainError(o.reason) ? o.reason.code : `raw ${sqlState(o.reason) ?? String(o.reason)}`,
    );
    expect(results.sort()).toEqual(["availability.dates_unavailable", "availability.dates_unavailable", "won"]); // never a raw 23P01 or 40P01
    expect(await db.select().from(holds).where(eq(holds.propertyId, p.id))).toHaveLength(1);
  }
});
