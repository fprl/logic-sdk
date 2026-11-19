import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import worker from "../src";

/** Sends a request and waits for the work kept alive by waitUntil (listeners), like the runtime does. */
async function send(path: string, init: { method?: string; body?: unknown; user?: string } = {}) {
  const request = new Request(`http://links.test${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    body: init.body ? JSON.stringify(init.body) : undefined,
    headers: { "content-type": "application/json", ...(init.user ? { "x-user": init.user } : {}) },
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

test("signed-in users shorten links", async () => {
  const res = await send("/links", { body: { url: "https://example.com", slug: "ex" }, user: "ana" });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ slug: "ex", url: "https://example.com", createdBy: "ana" });
});

test("each kind of error gets its own status", async () => {
  const anonymous = await send("/links", { body: { url: "https://example.com" } });
  expect(anonymous.status).toBe(403);
  expect(await anonymous.json()).toMatchObject({ error: { kind: "forbidden", code: "links.create.forbidden" } });

  const invalid = await send("/links", { body: { url: "not a url" }, user: "ana" });
  expect(invalid.status).toBe(400);

  await send("/links", { body: { url: "https://one.com", slug: "taken" }, user: "ana" });
  const taken = await send("/links", { body: { url: "https://two.com", slug: "taken" }, user: "leo" });
  expect(taken.status).toBe(409);
  expect(await taken.json()).toMatchObject({ error: { kind: "conflict", code: "links.slug_taken" } });

  const missing = await send("/nope");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { kind: "not_found", code: "links.not_found" } });
});

test("visiting redirects, and stats count it after the response", async () => {
  await send("/links", { body: { url: "https://hono.dev", slug: "hono" }, user: "ana" });

  const visit = await send("/hono");
  expect(visit.status).toBe(302);
  expect(visit.headers.get("location")).toBe("https://hono.dev");
  await send("/hono");

  const stats = await send("/links/hono/stats", { user: "ana" });
  expect(await stats.json()).toEqual({ slug: "hono", visits: 2 });
});

test("bindings are services: every new link is archived to R2", async () => {
  await send("/links", { body: { url: "https://developers.cloudflare.com", slug: "cf" }, user: "ana" });

  const object = await env.ARCHIVE.get("links/cf.json");
  expect(await object?.json()).toEqual({ slug: "cf", url: "https://developers.cloudflare.com", createdBy: "ana" });
});
