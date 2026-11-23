import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, test } from "vitest";
import { router } from "../src/rpc";
import { scopeAs, testRegistry } from "./setup";

const { t } = await testRegistry();

test("oRPC: the router in src/rpc.ts, server-side client, no HTTP", async () => {
  // internal functions are not in it, at the type level too
  // @ts-expect-error availability.hold is internal: other modules run it
  void router.availability.hold;

  const owner = createRouterClient(router, { context: { caller: t.registry.as(scopeAs("owner")) } });
  const p = await owner.properties.create({ name: "Villa", nightlyRate: 100_00, cleaningFee: 0, minNights: 1 });
  const name: string = p.name;
  expect(name).toEqual("Villa");

  const guest = createRouterClient(router, { context: { caller: t.registry.as(scopeAs(null)) } });
  const quote = await guest.pricing.priceStay({ propertyId: p.id, from: "2026-07-01", to: "2026-07-03" });
  expect(quote.total).toEqual(200_00);
  await expect(guest.properties.create({ name: "x", nightlyRate: 1, cleaningFee: 0 })).rejects.toMatchObject({ code: "FORBIDDEN", data: { code: "properties.create.forbidden" } });
});

test("oRPC: over HTTP with RPCHandler + typed client, domain errors keep their code", async () => {
  const handler = new RPCHandler(router);
  const serve = async (request: Request) => {
    const role = request.headers.get("x-role") as any;
    const { response } = await handler.handle(request, { prefix: "/rpc", context: { caller: t.registry.as(scopeAs(role || null)) } });
    return response ?? new Response("not found", { status: 404 });
  };
  const client = (role?: string): RouterClient<typeof router> =>
    createORPCClient(new RPCLink({
      origin: "http://local", url: "/rpc",
      headers: role ? { "x-role": role } : {},
      fetch: (url: string, init: RequestInit) => serve(new Request(url, init)),
    } as any));

  const p = await client("owner").properties.create({ name: "Loft", nightlyRate: 80_00, cleaningFee: 20_00, minNights: 1 });
  const b = await client().bookings.request({ propertyId: p.id, checkIn: "2026-07-01", checkOut: "2026-07-02", guestEmail: "g@x.com" });
  expect(b.total).toEqual(100_00);
  expect((await client("agent").bookings.confirm({ bookingId: b.id })).status).toEqual("confirmed");
  await expect(client("agent").bookings.confirm({ bookingId: b.id })).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT", data: { code: "bookings.not_pending" } });

  // the wire format, as the README's curl sends it: the input under "json"
  const raw = await serve(new Request("http://local/rpc/properties/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": "owner" },
    body: JSON.stringify({ json: { name: "Casa", nightlyRate: 10000, cleaningFee: 0, minNights: 1 } }),
  }));
  expect(raw.status).toEqual(200);
  expect(await raw.json()).toMatchObject({ json: { name: "Casa" } });
});
