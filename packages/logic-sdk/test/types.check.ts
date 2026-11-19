// Compile-only: proves inference is real (an `any` would make the @ts-expect-error lines fail as unused).
import { z } from "zod";
import { init } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null; tenant: string };
type Signed = Scope & { actor: string };
const { query, mutation, action, event, on, createRegistry: create } = init<{ scope: Scope; db: Store; reader: Readonly<Store>; services: { mail: (to: string) => void } }>()({
  policies: { anyone: () => true, signed: (s): s is Signed => s.actor !== null },
});

const ev = event({ schema: z.object({ id: z.string() }) });
const getOne = query({
  description: "q",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, ctx) => {
    const s: Scope = ctx.scope;
    // @ts-expect-error queries have no emit
    ctx.emit;
    // @ts-expect-error queries have no services
    ctx.services;
    return { id, n: 1 };
  },
});
const ping = action({ description: "p", inputSchema: z.object({}), execute: async () => "pong" });
const write = mutation({
  description: "m",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async ({ id }, ctx) => {
    const { run, emit } = ctx;
    // @ts-expect-error mutations have no services (side effects belong in actions/listeners)
    ctx.services;
    // @ts-expect-error mutations can't run actions
    await run(ping, {});
    const r = await run(getOne, { id });
    const n: number = r.n;
    emit(ev, { id });
    // @ts-expect-error payload must match the event schema
    emit(ev, { nope: 1 });
    return { ok: true as const };
  },
});
const act = action({
  description: "a",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, { run, services }) => {
    services.mail(id);
    const out = await run(write, { id });
    const ok: true = out.ok;
    return ok;
  },
});
const listener = on(() => ev, async (payload, { event, services }) => {
  const id: string = payload.id;
  const name: string = event.name;
  services.mail(id + name);
});

const registry = create({ modules: { c: { ev, getOne, ping, write, act, listener } }, database: memoryDatabase(), services: { mail: () => {} } });
// @ts-expect-error services are typed from init
create({ modules: {}, services: { nope: 1 } });
const mods: { c: { ev: typeof ev } } = { c: registry.modules.c };
const app = registry.as({ actor: "a", tenant: "t" });
async function check() {
  const r = await app.run(getOne, { id: "x" });
  const n: number = r.n;
  // @ts-expect-error unknown field
  r.nope;
  // @ts-expect-error wrong input
  await app.run(getOne, { id: 1 });
  const w = await app.run(write, { id: "x" });
  const t: true = w.ok;
  // @ts-expect-error scope fields are typed
  app.with({ nope: 1 });
  // @ts-expect-error scope must be complete
  registry.as({ actor: "a" });
  void n; void t;
}
void check;

// review #8: type holes
// @ts-expect-error services are required when the config declares them
create({ modules: {}, database: memoryDatabase() });
// @ts-expect-error a database is required when the config declares db
create({ modules: {}, services: { mail: () => {} } });
declare const maybe: ((s: Scope) => boolean) | undefined;
// @ts-expect-error expose must be definitely present or absent, so types and runtime exposure agree
query({ description: "x", inputSchema: z.object({}), expose: maybe, execute: async () => 1 });

// policies: names are checked, guards narrow the scope, inline checks see the input
query({ description: "x", inputSchema: z.object({}), expose: "signed", outputSchema: z.number(), execute: async (_, { scope }) => scope.actor.length });
mutation({ description: "x", inputSchema: z.object({}), expose: "signed", outputSchema: z.number(), execute: async (_, { scope }) => scope.actor.length });
query({ description: "x", inputSchema: z.object({}), expose: "anyone", outputSchema: z.void(), execute: async (_, { scope }) => {
  // @ts-expect-error a non-guard policy doesn't narrow
  scope.actor.length;
} });
query({ description: "x", inputSchema: z.object({ id: z.string() }), expose: (s, input) => s.tenant === input.id, outputSchema: z.number(), execute: async () => 1 });
// @ts-expect-error unknown policy name
query({ description: "x", inputSchema: z.object({}), expose: "nope", outputSchema: z.number(), execute: async () => 1 });
// @ts-expect-error exposed functions must declare outputSchema
query({ description: "x", inputSchema: z.object({}), expose: "anyone", execute: async () => 1 });
query({ description: "x", inputSchema: z.object({}), execute: async (_, { scope }) => {
  // @ts-expect-error internal functions keep the nullable actor
  scope.actor.length;
} });
const exposedQ = query({ description: "x", inputSchema: z.object({}), expose: "anyone", outputSchema: z.number(), execute: async () => 1 });
// errors live on ctx and return DomainError, so `throw` works everywhere
query({ description: "x", inputSchema: z.object({}), execute: async (_, ctx) => { throw ctx.notFound(); } });
action({ description: "x", inputSchema: z.object({}), execute: async (_, ctx) => { throw ctx.conflict("taken", { id: 1 }); } });
type IsExposed<F> = F extends import("../src/index.ts").ExposedFn ? true : false;
const exposedFlag: IsExposed<typeof exposedQ> = true;
// @ts-expect-error internal functions are not ExposedFn
const internalFlag: IsExposed<typeof getOne> = true;
void exposedFlag; void internalFlag;
const transforming = event({ schema: z.object({ at: z.string().transform((s) => new Date(s)) }) });
mutation({ description: "e", inputSchema: z.object({}), execute: async (_, { emit }) => {
  emit(transforming, { at: "2026-01-01" });
  // @ts-expect-error emit takes the schema input (string), not its output
  emit(transforming, { at: new Date() });
} });
on(() => transforming, async ({ at }) => { const d: Date = at; void d; });
import { createTestRegistry } from "../src/testing.ts";
void createTestRegistry(registry).transaction(async (tx) => {
  tx.stub(getOne, async ({ id }) => ({ id, n: 2 }));
  // @ts-expect-error stub must return the function's output type
  tx.stub(getOne, async () => ({ nope: true }));
});

// meta: one shape declared in init, values set per function, typed in wrap
{
  const m = init<{ scope: Scope; meta: { tags?: string[]; agent?: boolean } }>()();
  m.query({ description: "x", inputSchema: z.object({}), meta: { tags: ["a"], agent: false }, execute: async () => 1 });
  // @ts-expect-error meta must match the shape from init
  m.query({ description: "x", inputSchema: z.object({}), meta: { nope: 1 }, execute: async () => 1 });
  m.createRegistry({ modules: {}, wrap: async (call, next) => { const t: string[] | undefined = call.meta?.tags; void t; return next(); } });
  // @ts-expect-error without a meta shape in init, functions can't set meta
  query({ description: "x", inputSchema: z.object({}), meta: { tags: [] }, execute: async () => 1 });
}

// a typo in the config is an error, not a silently ignored key
// @ts-expect-error `servises` isn't a Config key
init<{ scope: Scope; servises: { mail: () => void } }>();
