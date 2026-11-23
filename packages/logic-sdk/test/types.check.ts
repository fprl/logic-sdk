// Compile-only: proves inference is real (an `any` would make the @ts-expect-error lines fail as unused).
import type { AIMeta } from "../src/ai.ts";
import { databaseQueue, drizzleAdapter, outbox, type DrizzleDb } from "../src/drizzle/pg.ts";
import * as sqlite from "../src/drizzle/sqlite.ts";
import type { PgBossMeta } from "../src/pg-boss.ts";
import { Database } from "bun:sqlite";
import { drizzle as bunSqlite } from "drizzle-orm/bun-sqlite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { z } from "zod";
import { inProcess, init, type Fn, type ForListeners, type JobsAdapter, type ReadWrite, type SqlDatabase } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null; tenant: string };
type Signed = Scope & { actor: string };
const { query, mutation, action, event, listener, cron, createRegistry: create } = init<{ scope: Scope; db: ReadWrite<Readonly<Store>, Store>; services: { mail: (to: string) => void } }>();
const anyone = () => true;
const signed = (s: Scope): s is Signed => s.actor !== null;

const ev = event({ payload: z.object({ id: z.string() }) });
const getOne = query({
  input: z.object({ id: z.string() }),
  handler: async (ctx, { id }) => {
    const s: Scope = ctx.scope;
    // @ts-expect-error queries have no emit
    ctx.emit;
    // @ts-expect-error queries have no services
    ctx.services;
    return { id, n: 1 };
  },
});
const ping = action({ input: z.object({}), handler: async () => "pong" });
const write = mutation({
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  handler: async (ctx, { id }) => {
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
  input: z.object({ id: z.string() }),
  handler: async ({ run, services }, { id }) => {
    services.mail(id);
    const out = await run(write, { id });
    const ok: true = out.ok;
    return ok;
  },
});
const onEv = listener({ event: () => ev, handler: async ({ event, services }, payload) => {
  const id: string = payload.id;
  const name: string = event.name;
  services.mail(id + name);
} });

const registry = create({ modules: { c: { ev, getOne, ping, write, act, onEv } }, database: memoryDatabase(), services: { mail: () => {} } });
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
  app.run(getOne, { id: "x" }, { scope: { nope: 1 } });
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
declare const maybe: true | undefined;
// @ts-expect-error expose must be definitely present or absent, so types and runtime exposure agree
query({ input: z.object({}), authorize: anyone, output: z.number(), expose: maybe, handler: async () => 1 });

// policies: imported functions; guards narrow the scope
query({ input: z.object({}), authorize: signed, expose: true, output: z.number(), handler: async ({ scope }) => scope.actor.length });
mutation({ input: z.object({}), authorize: signed, expose: true, output: z.number(), handler: async ({ scope }) => scope.actor.length });
// internal functions may have a policy too, and it narrows
mutation({ input: z.object({}), authorize: signed, handler: async ({ scope }) => scope.actor.length });
query({ input: z.object({}), authorize: anyone, expose: true, output: z.void(), handler: async ({ scope }) => {
  // @ts-expect-error a non-guard policy doesn't narrow
  scope.actor.length;
} });
// @ts-expect-error policies are sync
query({ input: z.object({}), authorize: async (s: Scope) => s.actor !== null, handler: async () => 1 });
// @ts-expect-error policies read only the scope, not the input
query({ input: z.object({ id: z.string() }), authorize: (s: Scope, input: { id: string }) => s.tenant === input.id, handler: async () => 1 });
// @ts-expect-error a policy name is not a policy
query({ input: z.object({}), authorize: "signed", handler: async () => 1 });
// @ts-expect-error expose: true needs authorize
query({ input: z.object({}), expose: true, output: z.number(), handler: async () => 1 });
// @ts-expect-error exposed functions must declare output
query({ input: z.object({}), authorize: anyone, expose: true, handler: async () => 1 });
query({ input: z.object({}), handler: async ({ scope }) => {
  // @ts-expect-error internal functions without a policy keep the nullable actor
  scope.actor.length;
} });
const exposedQ = query({ input: z.object({}), authorize: anyone, expose: true, output: z.number(), handler: async () => 1 });
// errors live on ctx.errors and return DomainError, so `throw` works everywhere
query({ input: z.object({}), handler: async (ctx) => { throw ctx.errors.notFound(); } });
action({ input: z.object({}), handler: async (ctx) => { throw ctx.errors.conflict("taken", { id: 1 }); } });
listener({ event: () => ev, handler: async (ctx) => { throw ctx.errors.reject("nope"); } });
type IsExposed<F> = F extends import("../src/index.ts").ExposedFn ? true : false;
const exposedFlag: IsExposed<typeof exposedQ> = true;
// @ts-expect-error internal functions are not ExposedFn
const internalFlag: IsExposed<typeof getOne> = true;
void exposedFlag; void internalFlag;
const transforming = event({ payload: z.object({ at: z.string().transform((s) => new Date(s)) }) });
mutation({ input: z.object({}), handler: async ({ emit }) => {
  emit(transforming, { at: "2026-01-01" });
  // @ts-expect-error emit takes the schema input (string), not its output
  emit(transforming, { at: new Date() });
} });
listener({ event: () => transforming, handler: async (_, { at }) => { const d: Date = at; void d; } });
import { createTestRegistry } from "../src/testing.ts";
{
  const t = createTestRegistry(registry);
  t.stub(getOne, async (_, input) => ({ id: input.id, n: 2 }));
  // @ts-expect-error stub must return the function's output type
  t.stub(getOne, async () => ({ nope: true }));
}

// meta: one shape declared in init, values set per function, typed in wrap
{
  const m = init<{ scope: Scope; meta: { tags?: string[]; agent?: boolean } }>();
  m.query({ input: z.object({}), meta: { tags: ["a"], agent: false }, handler: async () => 1 });
  // @ts-expect-error meta must match the shape from init
  m.query({ input: z.object({}), meta: { nope: 1 }, handler: async () => 1 });
  m.createRegistry({ modules: {}, wrap: async (call, next) => { const t: string[] | undefined = call.meta?.tags; void t; return next(); } });
  // @ts-expect-error without a meta shape in init, functions can't set meta
  query({ input: z.object({}), meta: { tags: [] }, handler: async () => 1 });
}

// a typo in the config is an error, not a silently ignored key
// @ts-expect-error `servises` isn't a Config key
init<{ scope: Scope; servises: { mail: () => void } }>();

// config: typed from init, read-only, required when declared, and test overrides are checked
{
  type AppConfig = { app: { url: string }; orders: { maxItems: number } };
  const c = init<{ scope: Scope; db: Store; config: AppConfig }>();
  const q = c.query({ input: z.object({}), handler: async ({ config }) => {
    const max: number = config.orders.maxItems;
    // @ts-expect-error config is read-only, all the way down
    config.orders.maxItems = 1;
    // @ts-expect-error unknown keys are errors
    config.orders.nope;
    return max;
  } });
  c.mutation({ input: z.object({}), handler: async ({ config }) => config.app.url });
  c.action({ input: z.object({}), handler: async ({ config }) => config.app.url });
  c.listener({ event: () => ev, handler: async ({ config }) => { const u: string = config.app.url; void u; } });
  const reg = c.createRegistry({ modules: { m: { q } }, database: memoryDatabase(), config: { app: { url: "u" }, orders: { maxItems: 1 } } });
  // @ts-expect-error config is required when the app declares it
  c.createRegistry({ modules: {}, database: memoryDatabase() });
  // @ts-expect-error a key you didn't declare is an error (picking secrets out stays explicit)
  c.createRegistry({ modules: {}, database: memoryDatabase(), config: { app: { url: "u" }, orders: { maxItems: 1 }, stripeKey: "sk" } });
  createTestRegistry(reg, { config: { orders: { maxItems: 2 } } }); // any part, at any depth
  // @ts-expect-error a typo in a test override is a compile error
  createTestRegistry(reg, { config: { orders: { maxItem: 2 } } });
  // @ts-expect-error and so is a wrong type
  createTestRegistry(reg, { config: { orders: { maxItems: "2" } } });
}

// config edge cases: branded strings stay strings, arrays are read-only, undeclared config can't be passed
{
  const Url = z.string().brand<"Url">();
  type Brandy = { url: z.infer<typeof Url>; tags: string[] };
  const b = init<{ scope: Scope; config: Brandy }>();
  b.query({ input: z.object({}), handler: async ({ config }) => {
    const s: string = config.url; // a branded string is still a string
    // @ts-expect-error arrays in config are read-only
    config.tags.push("x");
    return s;
  } });
  const none = init<{ scope: Scope }>();
  // @ts-expect-error without a declared config, passing one is an error, not silently ignored
  none.createRegistry({ modules: {}, config: { url: "x" } });
  const plainReg = none.createRegistry({ modules: {} });
  // @ts-expect-error and so is overriding one in a test
  createTestRegistry(plainReg, { config: { url: "x" } });
}

// no input: leave `input` out, the handler takes only ctx, and callers write run(fn)
{
  const total = query({ handler: async ({ scope }) => scope.tenant.length });
  const caller = create({ modules: {}, database: memoryDatabase(), services: { mail: () => {} } }).as({ actor: null, tenant: "t" });
  const n: Promise<number> = caller.run(total);
  void n;
  void caller.run(total, undefined, { signal: AbortSignal.timeout(1000) });
  // @ts-expect-error a function with input still needs it
  void caller.run(getOne);
  // @ts-expect-error and a function without input takes nothing else
  void caller.run(total, { id: "x" });
}

// jobs.scope: load gets what store saved, and returns the app's scope
{
  type JobScopeApp = { actor: string | null; locale: string };
  const m = init<{ scope: JobScopeApp }>();
  m.createRegistry({
    modules: {},
    jobs: {
      scope: {
        store: (s) => ({ who: s.actor }),
        load: (saved) => {
          // @ts-expect-error: only what store saved
          void saved.locale;
          return { actor: saved.who, locale: "es" };
        },
      },
    },
  });
  m.createRegistry({
    modules: {},
    jobs: {
      scope: {
        // load first: annotate its parameter, since TypeScript reads the object in order (or write store first)
        load: (saved: { who: string | null }) => ({ actor: saved.who, locale: "es" }),
        store: (s) => ({ who: s.actor }),
      },
    },
  });
  m.createRegistry({
    modules: {},
    // @ts-expect-error: load must return the app's scope (or null)
    jobs: { scope: { load: () => ({ nope: 1 }) } },
  });
  // keeping the scope as it was, the documented escape hatch: `saved` is the app's scope, unannotated
  m.createRegistry({ modules: {}, jobs: { adapter: { async deliver() {} }, scope: { load: (saved) => saved } } });
}

// Drizzle's synchronous SQLite drivers commit before an async mutation finishes, and Drizzle's types reject them
// @ts-expect-error "Sync drivers can't use async functions in transactions!"
drizzleAdapter(bunSqlite({ client: new Database(":memory:") }));

// cron: input is required exactly when the function needs one, typed by it; scope is the app's
{
  const system: Scope = { actor: "system", tenant: "all" };
  const needs = mutation({ input: z.object({ n: z.number() }), handler: async () => 1 });
  const none = query({ handler: async () => 1 });
  cron({ schedule: "* * * * *", run: needs, input: { n: 1 }, scope: system });
  cron({ schedule: "* * * * *", run: none, scope: system });
  // @ts-expect-error the function needs input
  cron({ schedule: "* * * * *", run: needs, scope: system });
  // @ts-expect-error input typed by the function
  cron({ schedule: "* * * * *", run: needs, input: { n: "1" }, scope: system });
  // @ts-expect-error scope must be the app's
  cron({ schedule: "* * * * *", run: none, scope: { nope: 1 } });
}

// db: DrizzleDb gives queries a reader and mutations the transaction
{
  const d = init<{ scope: Scope; db: DrizzleDb<PgliteDatabase> }>();
  d.query({ handler: async (ctx) => ctx.db.select() });
  // @ts-expect-error queries can't write
  d.query({ handler: async (ctx) => ctx.db.insert });
  d.mutation({ handler: async (ctx) => ctx.db.insert });
  // @ts-expect-error no savepoints: one rolled back would keep the events emitted inside it
  d.mutation({ handler: async (ctx) => ctx.db.transaction(async () => {}) });
  // a helper typed with Drizzle's own classes still takes the mutation's transaction
  const count = async (x: PgliteDatabase) => x.$count;
  d.mutation({ handler: async (ctx) => count(ctx.db) });
  d.createRegistry({ modules: {}, database: drizzleAdapter({} as PgliteDatabase) });
  // @ts-expect-error the registry still needs the database
  d.createRegistry({ modules: {} });
}

// no db: the type says what to do
{
  const n = init<{ scope: Scope }>();
  const says = (_: { readonly setupError: "Add db to the Config you pass to init" }) => {};
  n.query({ handler: async (ctx) => says(ctx.db) });
  n.mutation({ handler: async (ctx) => says(ctx.db) });
  // @ts-expect-error no database was declared
  n.query({ handler: async (ctx) => ctx.db.select() });
  n.createRegistry({ modules: {} });
}

// meta: yours goes everywhere, each adapter's where it reads it, per init
{
  type AppMeta = { area: "shop" | "orders" };
  type QueueMeta = ForListeners<{ queue?: { priority: number } }>; // someone else's adapter
  const shop = init<{ scope: Scope; meta: AppMeta & AIMeta & PgBossMeta & QueueMeta }>();
  const happened = shop.event({ payload: z.object({}) });
  shop.action({ meta: { area: "shop", ai: { tool: true } }, handler: async () => 1 });
  shop.listener({ event: () => happened, meta: { area: "orders", pgBoss: {}, queue: { priority: 1 } }, handler: async () => 1 });
  shop.createRegistry({
    modules: {},
    wrap: async (call, next) => {
      const seen: [AppMeta["area"] | undefined, boolean | undefined, object | undefined] = [call.meta?.area, call.meta?.ai?.tool, call.meta?.pgBoss];
      void seen;
      return next();
    },
  });
  // @ts-expect-error pg-boss only reads listeners
  shop.action({ meta: { area: "shop", pgBoss: {} }, handler: async () => 1 });
  // @ts-expect-error AI only reads functions
  shop.listener({ event: () => happened, meta: { area: "shop", ai: {} }, handler: async () => 1 });
  // @ts-expect-error a typo inside an adapter's options
  shop.action({ meta: { area: "shop", ai: { tol: true } }, handler: async () => 1 });
  // @ts-expect-error the app's own part is still required
  shop.action({ meta: { ai: { tool: true } }, handler: async () => 1 });

  const admin = init<{ scope: Scope; meta: AIMeta }>();
  const changed = admin.event({ payload: z.object({}) });
  admin.action({ meta: { ai: {} }, handler: async () => 1 });
  // @ts-expect-error this init didn't add pg-boss
  admin.action({ meta: { pgBoss: {} }, handler: async () => 1 });
  // @ts-expect-error nothing here is read on listeners, so there's no meta to set
  admin.listener({ event: () => changed, meta: { anything: 1 }, handler: async () => 1 });
}

// three ways: the database is the queue, the queue alone, or an outbox in front of a queue
{
  const database = drizzleAdapter({} as PgliteDatabase);
  const queue = { async deliver() {} };
  // @ts-expect-error the adapter, not the Drizzle database
  databaseQueue({} as PgliteDatabase);
  databaseQueue(database, { lease: 60 });
  outbox(database, queue, { maxAttempts: 3 });
  // @ts-expect-error an outbox is in front of a queue
  outbox(database);
  // @ts-expect-error maxAttempts counts sends, and a database queue sends nothing
  databaseQueue(database, { maxAttempts: 3 });
}

// an adapter that keeps jobs needs jobs.scope
{
  const { createRegistry } = init<{ scope: { userId: string; role: string } }>();
  const queue: JobsAdapter = { async deliver() {} };
  createRegistry({ modules: {}, jobs: { adapter: inProcess() } });
  createRegistry({ modules: {}, jobs: { adapter: queue, scope: { load: (saved) => saved } } });
  createRegistry({
    modules: {},
    jobs: { adapter: queue, scope: { store: (s) => ({ id: s.userId }), load: (saved) => ({ userId: saved.id, role: "today" }) } },
  });
  // @ts-expect-error who would its jobs run as?
  createRegistry({ modules: {}, jobs: { adapter: queue } });
  // @ts-expect-error an adapter picked per env may be the one that keeps jobs
  createRegistry({ modules: {}, jobs: { adapter: Math.random() ? queue : inProcess() } });
}

// another ORM: the seam is `query` on the adapter (Prisma's shape)
{
  interface PrismaTx {
    $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
    booking: { count(): Promise<number> };
  }
  interface PrismaClient extends PrismaTx {
    $transaction<R>(fn: (tx: PrismaTx) => Promise<R>): Promise<R>;
  }
  const prisma = {} as PrismaClient;
  const database = {
    db: prisma,
    transactions: "interactive",
    transaction: (fn) => prisma.$transaction(fn),
    query: (client, text, params) => client.$queryRawUnsafe(text, ...params),
  } satisfies SqlDatabase<PrismaClient, PrismaTx>;
  // @ts-expect-error without query, jobs can't use your database
  ({ db: prisma, transactions: "interactive", transaction: (fn) => prisma.$transaction(fn) }) satisfies SqlDatabase<PrismaClient, PrismaTx>;
  const { createRegistry } = init<{ scope: { who: string }; db: ReadWrite<PrismaClient, PrismaTx> }>();
  createRegistry({ modules: {}, database, jobs: { adapter: databaseQueue(database), scope: { load: (saved) => saved } } });
}

// SQLite: one function that opens it, the same names, and queries that can't write
{
  const open = () => bunSqlite({ client: new Database("app.db") });
  const database = sqlite.drizzleAdapter(open, { transactionAttempts: 5 });
  const { query, createRegistry } = init<{ scope: object; db: sqlite.DrizzleDb<ReturnType<typeof open>> }>();
  createRegistry({ modules: {}, database, jobs: { adapter: sqlite.databaseQueue(database), scope: { load: (saved) => saved } } });
  // @ts-expect-error a query has no insert
  query({ handler: async (ctx) => ctx.db.insert });
  // @ts-expect-error the function, not a connection
  sqlite.drizzleAdapter(open());
}

// A module defined with another init() would run with this registry's scope: an error, events aside
{
  const shop = init<{ scope: { user: string | null } }>();
  const admin = init<{ scope: { admin: string } }>();
  const placed = shop.event({ payload: z.object({ id: z.string() }) });
  const refund = shop.mutation({ handler: async (ctx) => ctx.scope.user });
  const audit = shop.listener({ event: () => placed, handler: async () => {} });
  const sweep = shop.cron({ schedule: "0 * * * *", run: refund, scope: { user: null } });
  const ban = admin.mutation({ handler: async (ctx) => ctx.scope.admin });
  admin.createRegistry({ modules: { admin: { ban, placed } } });
  const annotated: Fn = ban; // a type that lost its init passes: nothing to tell
  admin.createRegistry({ modules: { admin: { annotated } } });
  // @ts-expect-error a mutation from the shop's init
  admin.createRegistry({ modules: { admin: { ban, refund } } });
  // @ts-expect-error a listener from the shop's init
  admin.createRegistry({ modules: { admin: { audit } } });
  // @ts-expect-error a cron from the shop's init
  admin.createRegistry({ modules: { admin: { sweep } } });
}
