import { serve } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/fetch";
import { toFetchHandler } from "logic-sdk/fetch";
import { toORPCRouter } from "logic-sdk/orpc";
import { Hono } from "hono";
import { db } from "./db/client";
import { makeRegistry } from "./registry";
import type { Role, Scope } from "./scope";
import { memoryPayments } from "./services";

// One registry for the process: a long-lived Node server shares the pool and the definitions.
const registry = makeRegistry(db, {
  mailer: { send: async (m) => console.log("[mail]", m) }, // swap for Resend, Postmark...
  payments: memoryPayments(), // swap for Stripe
});

// Demo auth: `x-user: ana:owner`. Put your real auth here (Better Auth, Clerk, a session cookie...).
function scopeOf(req: Request): Scope {
  const [id, role] = req.headers.get("x-user")?.split(":") ?? [];
  return {
    actor: id && role ? { id, role: role as Role } : null,
    accountId: req.headers.get("x-account") ?? "acc_1",
    locale: req.headers.get("accept-language")?.slice(0, 2) ?? "en",
    requestId: crypto.randomUUID(),
  };
}

const app = new Hono();

// Plain JSON over HTTP: POST /api/bookings.request, GET /api/pricing.priceStay?input=...
const api = toFetchHandler(registry, { basePath: "/api/", resolveScope: scopeOf });
app.all("/api/*", (c) => api(c.req.raw));

// Typed client for your frontend: createORPCClient<ORPCRouterOf<...>>(new RPCLink({ url: "/rpc" }))
const rpc = new RPCHandler(toORPCRouter(registry));
app.all("/rpc/*", async (c) => {
  const { response } = await rpc.handle(c.req.raw, { prefix: "/rpc", context: { caller: registry.as(scopeOf(c.req.raw)) } });
  return response ?? c.notFound();
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => console.log(`http://localhost:${info.port}`));
