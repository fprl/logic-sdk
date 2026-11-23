import { createRouterClient, os } from "@orpc/server";
import { expect, test } from "bun:test";
import { z } from "zod";
import { init } from "../src/index.ts";
import { toORPCProcedure, type ORPCContext } from "../src/orpc.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null };
const { query, mutation, createRegistry } = init<{ scope: Scope; db: Store }>();
const anyone = () => true;
const signedIn = (s: Scope): s is { actor: string } => s.actor !== null;

const add = mutation({
  input: z.object({ name: z.string() }),
  output: z.object({ name: z.string() }),
  authorize: signedIn,
  async handler({ db, errors }, { name }) {
    if (name === "taken") throw errors.conflict("taken");
    (db.rows.items ??= []).push({ name, secret: "hash" });
    return { name, secret: "hash" } as { name: string }; // output strips what isn't declared
  },
});
const count = query({ authorize: anyone, handler: async ({ db }) => (db.rows.items ?? []).length });
const purge = mutation({ handler: async () => {} }); // internal: no authorize

const registry = createRegistry({ modules: { items: { add, count, purge } }, database: memoryDatabase() });

// your router: our procedures next to your own, with your own middleware
const seen: string[] = [];
const router = {
  items: {
    add: toORPCProcedure(add).use(({ next, path }) => (seen.push(path.join(".")), next())),
    count: toORPCProcedure(count),
  },
  health: os.handler(() => "ok"),
};
const clientAs = (actor: string | null) => createRouterClient(router, { context: { caller: registry.as({ actor }) } });

test("toORPCProcedure: a procedure for your own router; composes with your middleware; output is checked", async () => {
  const added = await clientAs("ana").items.add({ name: "desk" });
  expect(added).toEqual({ name: "desk" });
  const name: string = added.name;
  void name;
  expect(await clientAs(null).items.count()).toEqual(1);
  expect(await clientAs(null).health()).toEqual("ok");
  expect(seen).toEqual(["items.add"]);
});

test("toORPCProcedure: domain errors keep their kind and code", async () => {
  await expect(clientAs(null).items.add({ name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN", data: { code: "items.add.forbidden" } });
  await expect(clientAs("ana").items.add({ name: "taken" })).rejects.toMatchObject({ code: "CONFLICT", data: { kind: "conflict", code: "items.taken" } });
});

test("toORPCProcedure: a function nobody authorized is refused, by type and at runtime", () => {
  // @ts-expect-error nobody said who may call it
  expect(() => toORPCProcedure(purge)).toThrow(/needs authorize/);
});

test("the context is typed with the init's scope", () => {
  // @ts-expect-error a caller for another scope
  createRouterClient({ add: toORPCProcedure(add) }, { context: { caller: {} as ORPCContext<{ tenant: string }>["caller"] } });
});
