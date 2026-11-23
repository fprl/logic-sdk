import { isDomainError, type Caller } from "logic-sdk";
import { toResponse } from "logic-sdk/fetch";
import { Hono, type Context } from "hono";
import * as catalog from "./catalog";
import type { Scope } from "./logic";
import * as orders from "./orders";
import type { Shop } from "./registry";

type Env<Bindings> = { Bindings: Bindings; Variables: { caller: Caller<Scope> } };

/** The JSON API, the same on Node and Workers. Each host says how to get its shop for a request. */
export function createApi<Bindings extends object = object>(shopFor: (c: Context<Env<Bindings>>) => Shop) {
  const app = new Hono<Env<Bindings>>();

  // One caller per request: the shop, and who is calling.
  app.use(async (c, next) => {
    c.set("caller", shopFor(c).as(scopeOf(c.req.raw)));
    await next();
  });

  app.get("/products", async (c) => c.json(await c.var.caller.run(catalog.list)));

  app.post("/orders", async (c) => {
    const order = await c.var.caller.run(orders.place, await c.req.json());
    return c.json(order, 201);
  });

  app.get("/orders", async (c) => c.json(await c.var.caller.run(orders.mine)));

  app.post("/orders/:id/cancel", async (c) => {
    return c.json(await c.var.caller.run(orders.cancel, { orderId: c.req.param("id") }));
  });

  app.post("/orders/:id/ship", async (c) => {
    return c.json(await c.var.caller.run(orders.ship, { orderId: c.req.param("id") }));
  });

  // A domain error is its status and code; anything else, a bare 500, logged here, never sent.
  app.onError((error, c) => {
    if (isDomainError(error)) return toResponse(error);
    console.error(error);
    return c.json({ error: { kind: "internal" } }, 500);
  });

  return app;
}

/** Demo auth: `x-user: ana` is a customer, `x-user: sam:staff` works here. Put your real session lookup here. Never the system. */
function scopeOf(request: Request): Scope {
  const [id, role] = request.headers.get("x-user")?.split(":") ?? [];
  if (!id) return { user: null };
  return { user: { id, role: role === "staff" ? "staff" : "customer" } };
}
