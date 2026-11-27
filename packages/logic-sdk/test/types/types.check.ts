// Compile-only: proves inference is real (an `any` would make the @ts-expect-error lines fail as unused).
import type { AIMeta } from "../../src/ai.ts";
import { databaseQueue, drizzleAdapter, outbox, type DrizzleDb, type DrizzleTx } from "../../src/drizzle/pg.ts";
import * as sqlite from "../../src/drizzle/sqlite.ts";
import { Database } from "bun:sqlite";
import { drizzle as bunSqlite } from "drizzle-orm/bun-sqlite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { z } from "zod";
import { inProcess, init, type Fn, type ForListeners, type JobsAdapter, type ReadWrite, type SqlDatabase } from "../../src/index.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

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

const registry = create({ modules: { c: { ev, getOne, ping, write, act, onEv } }, database: { adapter: memoryDatabase() }, services: { mail: () => {} } });
// @ts-expect-error services are typed from init
create({ modules: {}, services: { nope: 1 } });
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
  // @ts-expect-error a run's scope is whole: a patch could build a scope that's none of your variants
  app.run(getOne, { id: "x" }, { scope: { actor: "b" } });
  app.run(getOne, { id: "x" }, { scope: { actor: "b", tenant: "t" } });
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

// policies: imported functions; guards narrow the scope
query({ input: z.object({}), authorize: signed, output: z.number(), handler: async ({ scope }) => scope.actor.length });
mutation({ input: z.object({}), authorize: signed, output: z.number(), handler: async ({ scope }) => scope.actor.length });
// internal functions may have a policy too, and it narrows
mutation({ input: z.object({}), authorize: signed, handler: async ({ scope }) => scope.actor.length });
query({ input: z.object({}), authorize: anyone, output: z.void(), handler: async ({ scope }) => {
  // @ts-expect-error a non-guard policy doesn't narrow
  scope.actor.length;
} });
// @ts-expect-error policies are sync
query({ input: z.object({}), authorize: async (s: Scope) => s.actor !== null, handler: async () => 1 });
// @ts-expect-error policies read only the scope, not the input
query({ input: z.object({ id: z.string() }), authorize: (s: Scope, input: { id: string }) => s.tenant === input.id, handler: async () => 1 });
// @ts-expect-error a policy name is not a policy
query({ input: z.object({}), authorize: "signed", handler: async () => 1 });
query({ input: z.object({}), handler: async ({ scope }) => {
  // @ts-expect-error internal functions without a policy keep the nullable actor
  scope.actor.length;
} });
const authorizedQ = query({ input: z.object({}), authorize: anyone, handler: async () => 1 });
// errors live on ctx.errors and return DomainError, so `throw` works everywhere
query({ input: z.object({}), handler: async (ctx) => { throw ctx.errors.notFound(); } });
action({ input: z.object({}), handler: async (ctx) => { throw ctx.errors.conflict("taken", { id: 1 }); } });
listener({ event: () => ev, handler: async (ctx) => { throw ctx.errors.reject("nope"); } });
// publishable: it says who may call it (output is optional: without it, the handler's type)
type IsPublishable<F> = F extends import("../../src/index.ts").PublishableFn ? true : false;
const publishable: IsPublishable<typeof authorizedQ> = true;
// @ts-expect-error nobody said who may call it
const unauthorized: IsPublishable<typeof getOne> = true;
// an inline policy counts too, and an inline guard still narrows
const inline = query({ authorize: (s) => s.tenant !== "", handler: async () => 1 });
const inlineGuard = mutation({ authorize: (s): s is Signed => s.actor !== null, handler: async ({ scope }) => scope.actor.length });
const inlineOk: [IsPublishable<typeof inline>, IsPublishable<typeof inlineGuard>] = [true, true];
void publishable; void unauthorized; void inlineOk;
const transforming = event({ payload: z.object({ at: z.string().transform((s) => new Date(s)) }) });
mutation({ input: z.object({}), handler: async ({ emit }) => {
  emit(transforming, { at: "2026-01-01" });
  // @ts-expect-error emit takes the schema input (string), not its output
  emit(transforming, { at: new Date() });
} });
listener({ event: () => transforming, handler: async (_, { at }) => { const d: Date = at; void d; } });
// key and unique get the payload the handler gets; a timeout is seconds
listener({ event: () => ev, key: (p) => p.id, unique: (p) => p.id, timeout: 30, handler: async () => {} });
listener({ event: () => transforming, key: (p) => p.at.toISOString(), handler: async () => {} });
// failed: the handler's ctx and payload (parsed), then the error
listener({ event: () => transforming, queue: "mail", handler: async () => {}, failed: async (ctx, { at }, error) => { const d: Date = at; const n: number = ctx.event.attempt; void d; void n; void error; } });
// @ts-expect-error a queue is a name
listener({ event: () => ev, queue: 1, handler: async () => {} });
// @ts-expect-error a key is a string
listener({ event: () => ev, key: (p) => p.id.length, handler: async () => {} });
// @ts-expect-error only fields the payload has
listener({ event: () => ev, unique: (p) => p.missing, handler: async () => {} });
import { createTestRegistry } from "../../src/testing.ts";
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
  const reg = c.createRegistry({ modules: { m: { q } }, database: { adapter: memoryDatabase() }, config: { app: { url: "u" }, orders: { maxItems: 1 } } });
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
  const caller = create({ modules: {}, database: { adapter: memoryDatabase() }, services: { mail: () => {} } }).as({ actor: null, tenant: "t" });
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

// cron: a handler, like a listener's; ctx.scope is the scope it declares, and that scope is the app's
{
  const needs = mutation({ input: z.object({ n: z.number() }), handler: async () => 1 });
  cron({
    schedule: "* * * * *",
    scope: { actor: "system", tenant: "all" },
    async handler(ctx) {
      const actor: "system" = ctx.scope.actor; // the declared scope, not the whole union
      const at: string = ctx.cron.scheduledAt;
      const attempt: number = ctx.cron.attempt;
      await ctx.run(needs, { n: 1 });
      // @ts-expect-error input typed by the function
      await ctx.run(needs, { n: "1" });
      void actor; void at; void attempt;
    },
  });
  // @ts-expect-error scope must be the app's
  cron({ schedule: "* * * * *", scope: { nope: 1 }, handler: async () => {} });
  // @ts-expect-error the work is the handler: no run
  cron({ schedule: "* * * * *", scope: { actor: "system", tenant: "all" }, run: () => needs, handler: async () => {} });
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
  // a helper typed with Drizzle's own classes would reach `transaction`: type it with DrizzleTx
  const viaDrizzle = async (x: PgliteDatabase) => x.$count;
  // @ts-expect-error not a Drizzle class: no `transaction` on it
  d.mutation({ handler: async (ctx) => viaDrizzle(ctx.db) });
  const viaTx = async (x: DrizzleTx<PgliteDatabase>) => x.$count;
  d.mutation({ handler: async (ctx) => viaTx(ctx.db) });
  d.createRegistry({ modules: {}, database: { adapter: drizzleAdapter({} as PgliteDatabase) } });
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
  const shop = init<{ scope: Scope; meta: AppMeta & AIMeta & QueueMeta }>();
  const happened = shop.event({ payload: z.object({}) });
  shop.action({ meta: { area: "shop", ai: { description: "Ship it" } }, handler: async () => 1 });
  shop.listener({ event: () => happened, meta: { area: "orders", queue: { priority: 1 } }, handler: async () => 1 });
  shop.createRegistry({
    modules: {},
    wrap: async (call, next) => {
      const seen: [AppMeta["area"] | undefined, string | undefined, object | undefined] = [call.meta?.area, call.meta?.ai?.description, call.meta?.queue];
      void seen;
      return next();
    },
  });
  // @ts-expect-error the queue only reads listeners
  shop.action({ meta: { area: "shop", queue: { priority: 1 } }, handler: async () => 1 });
  // @ts-expect-error AI only reads functions
  shop.listener({ event: () => happened, meta: { area: "shop", ai: {} }, handler: async () => 1 });
  // @ts-expect-error a typo inside an adapter's options
  shop.action({ meta: { area: "shop", ai: { tol: true } }, handler: async () => 1 });
  // @ts-expect-error the app's own part is still required
  shop.action({ meta: { ai: { description: "x" } }, handler: async () => 1 });

  const admin = init<{ scope: Scope; meta: AIMeta }>();
  const changed = admin.event({ payload: z.object({}) });
  admin.action({ meta: { ai: {} }, handler: async () => 1 });
  // @ts-expect-error this init didn't add the queue
  admin.action({ meta: { queue: { priority: 1 } }, handler: async () => 1 });
  // @ts-expect-error nothing here is read on listeners, so there's no meta to set
  admin.listener({ event: () => changed, meta: { anything: 1 }, handler: async () => 1 });
}

// three ways: the database is the queue, the queue alone, or an outbox in front of a queue
{
  const database = drizzleAdapter({} as PgliteDatabase);
  const queue = { async deliver() {} };
  // @ts-expect-error it takes the registry's database: nothing to pass
  databaseQueue(database);
  databaseQueue({ lease: 60, runIn: "worker" });
  outbox(queue, { lease: 60 });
  // @ts-expect-error behind an outbox, the queue's consumers run the jobs
  outbox(queue, { runIn: "worker" });
  // @ts-expect-error an outbox is in front of a queue
  outbox(database);
  // @ts-expect-error maxAttempts counts sends, and a database queue sends nothing
  databaseQueue({ maxAttempts: 3 });
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
    transaction: (fn) => prisma.$transaction(fn),
    query: (client, text, params) => client.$queryRawUnsafe(text, ...params),
  } satisfies SqlDatabase<PrismaClient, PrismaTx>;
  // @ts-expect-error without query, jobs can't use your database
  ({ db: prisma, transaction: (fn) => prisma.$transaction(fn) }) satisfies SqlDatabase<PrismaClient, PrismaTx>;
  const { createRegistry } = init<{ scope: { who: string }; db: ReadWrite<PrismaClient, PrismaTx> }>();
  createRegistry({ modules: {}, database: { adapter: database }, jobs: { adapter: databaseQueue(), scope: { load: (saved) => saved } } });
}

// SQLite: one function that opens it, the same names, and queries that can't write
{
  const open = () => bunSqlite({ client: new Database("app.db") });
  const database = sqlite.drizzleAdapter(open);
  const { query, createRegistry } = init<{ scope: object; db: sqlite.DrizzleDb<ReturnType<typeof open>> }>();
  createRegistry({ modules: {}, database: { adapter: database }, jobs: { adapter: sqlite.databaseQueue(), scope: { load: (saved) => saved } } });
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
  const sweep = shop.cron({ schedule: "0 * * * *", scope: { user: null }, handler: (ctx) => ctx.run(refund) });
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

// `when` gets the event's parsed payload, and is sync: a Promise would always pass
{
  listener({ event: () => ev, when: (p) => p.id !== "", handler: async () => {} });
  // @ts-expect-error async: a Promise is truthy, so it would never filter
  listener({ event: () => ev, when: async (p) => p.id !== "", handler: async () => {} });
}

// `fn.input` is the schema as written, so a form derives from the function it calls. Without input it's undefined.
const noInput = query({ handler: async () => 1 });
const idOnly = getOne.input.pick({ id: true });
const idField: z.ZodString = getOne.input.shape.id;
const nothing: undefined = noInput.input;
// @ts-expect-error a function without input has no schema to pick from
noInput.input.pick;
