import { isDomainError, type Caller } from "logic-sdk";
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

  app.onError((error, c) => {
    if (!isDomainError(error)) {
      console.error(error);
      return c.json({ error: { kind: "internal" } }, 500);
    }

    const body = { error: { kind: error.kind, code: error.code, details: error.details } };
    switch (error.kind) {
      case "invalid":
        return c.json(body, 400);
      case "unauthenticated":
        return c.json(body, 401);
      case "forbidden":
        return c.json(body, 403);
      case "not_found":
        return c.json(body, 404);
      case "conflict":
        return c.json(body, 409);
      case "rejected":
        return c.json(body, 422);
    }
  });

  return app;
}

/** Demo auth: `x-user: ana` is a customer, `x-user: sam:staff` works here. Put your real session lookup here. */
function scopeOf(request: Request): Scope {
  const [id, role] = request.headers.get("x-user")?.split(":") ?? [];
  return { user: id ? { id, role: role === "staff" ? "staff" : "customer" } : null };
}
