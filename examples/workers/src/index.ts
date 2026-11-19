import { isDomainError, type Caller } from "logic-sdk";
import { drizzleAdapter } from "logic-sdk/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres from "postgres";
import { createRegistry, type Scope } from "./logic";
import * as links from "./links";
import * as stats from "./stats";

const app = new Hono<{ Bindings: Env; Variables: { caller: Caller<Scope> } }>();

// One caller per request: this request's database and bindings, and who is calling.
app.use(async (c, next) => {
  // Hyperdrive pools the connections, so a client per request is the recommended setup.
  const sql = postgres(c.env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });

  const registry = createRegistry({
    modules: { links, stats },
    database: drizzleAdapter(drizzle({ client: sql })),
    services: { archive: c.env.ARCHIVE },
    // Let listeners (the R2 archive, the visit counter) finish after the response is sent
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });

  // Demo auth: `x-user: ana`. Put your real session lookup here.
  const scope: Scope = { user: c.req.header("x-user") ?? null };

  c.set("caller", registry.as(scope));
  await next();
});

app.post("/links", async (c) => {
  const link = await c.var.caller.run(links.create, await c.req.json());
  return c.json(link, 201);
});

app.get("/links/:slug/stats", async (c) => {
  const result = await c.var.caller.run(stats.get, { slug: c.req.param("slug") });
  return c.json(result);
});

app.get("/:slug", async (c) => {
  const { url } = await c.var.caller.run(links.visit, { slug: c.req.param("slug") });
  return c.redirect(url);
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

export default app;
