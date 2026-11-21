import { z } from "zod";
import { expect, test } from "bun:test";
import { toFetchHandler, unauthenticated } from "../src/fetch.ts";
import { init } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null };
const { query, mutation, createRegistry } = init<{ scope: Scope; db: Store }>();
const signedIn = (s: Scope): s is Scope & { actor: string } => s.actor !== null;

const ping = query({ authorize: signedIn, output: z.string(), expose: true, handler: async () => "pong" });
const take = mutation({
  input: z.object({ what: z.string() }),
  output: z.string(),
  authorize: signedIn,
  expose: true,
  async handler(ctx, { what }) {
    if (what === "taken") throw ctx.errors.conflict("taken");
    if (what === "crash") throw new Error("secret connection string in here");
    return what;
  },
});
const registry = createRegistry({ modules: { x: { ping, take } }, database: memoryDatabase() });

const errors: unknown[] = [];
const handler = toFetchHandler(registry, {
  resolveScope: (req) => {
    if (req.headers.get("x-session") === "expired") throw unauthenticated();
    return { actor: req.headers.get("x-user") };
  },
  onError: (e) => void errors.push(e),
});
const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`http://x/${id}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-user": "ana", ...headers } }));

test("an unexpected error is a 500 with nothing from the error, and goes to onError", async () => {
  const res = await post("x.take", { what: "crash" });
  expect(res.status).toBe(500);
  expect(await res.text()).not.toContain("secret");
  expect(errors).toHaveLength(1);
});

test("domain errors map to their status: 401 from resolveScope, 409 for a conflict", async () => {
  expect((await post("x.take", { what: "a" }, { "x-session": "expired" })).status).toBe(401);
  const conflict = await post("x.take", { what: "taken" });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { kind: "conflict", code: "x.taken" } });
});

test("a mutation only takes POST with JSON; a query also takes GET", async () => {
  const get = await handler(new Request("http://x/x.take?input={}", { headers: { "x-user": "ana" } }));
  expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
  const form = await handler(new Request("http://x/x.take", { method: "POST", body: "what=a", headers: { "content-type": "application/x-www-form-urlencoded", "x-user": "ana" } }));
  expect(form.status).toBe(415); // a cross-site form can't send JSON without a preflight
  expect(await (await handler(new Request("http://x/x.ping", { headers: { "x-user": "ana" } }))).json()).toEqual({ data: "pong" });
});
