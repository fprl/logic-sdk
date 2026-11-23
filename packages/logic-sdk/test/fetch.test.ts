import { z } from "zod";
import { expect, test } from "bun:test";
import { toResponse } from "../src/fetch.ts";
import { init, unauthenticated } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null };
const { mutation, createRegistry } = init<{ scope: Scope; db: Store }>();
const signedIn = (s: Scope): s is Scope & { actor: string } => s.actor !== null;

const take = mutation({
  input: z.object({ what: z.string() }),
  output: z.string(),
  authorize: signedIn,
  async handler(ctx, { what }) {
    if (what === "taken") throw ctx.errors.conflict("taken");
    if (what === "crash") throw new Error("secret connection string in here");
    return what;
  },
});
const registry = createRegistry({ modules: { x: { take } }, database: memoryDatabase() });

/** A route, as you'd write one in Hono or Next: run the function, map a domain error. */
async function route(request: Request) {
  try {
    if (request.headers.get("x-session") === "expired") throw unauthenticated();
    return Response.json(await registry.as({ actor: request.headers.get("x-user") || null }).run(take, await request.json()));
  } catch (e) {
    return toResponse(e);
  }
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  route(new Request("http://x/take", { method: "POST", body: JSON.stringify(body), headers: { "x-user": "ana", ...headers } }));

test("toResponse: a domain error is its status and a JSON body; 401 for unauthenticated(), 403 for a policy", async () => {
  const conflict = await post({ what: "taken" });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: { kind: "conflict", code: "x.taken" } });
  expect((await post({ what: "a" }, { "x-session": "expired" })).status).toBe(401);
  expect((await post({ what: "a" }, { "x-user": "" })).status).toBe(403);
  expect(await (await post({ what: "a" })).json()).toEqual("a");
});

test("toResponse: anything else is thrown again, so the framework makes the 500 and nothing leaks", async () => {
  await expect(post({ what: "crash" })).rejects.toThrow("secret connection string in here");
  const error = new Error("boom");
  expect(() => toResponse(error)).toThrow(error);
});
