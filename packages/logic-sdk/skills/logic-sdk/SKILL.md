---
name: logic-sdk
description: Write and change business logic with logic-sdk (queries, mutations, actions, events, listeners, policies, modules, tests). Use when adding a module or function, wiring createRegistry, writing authorize policies or can* checks, emitting events, or testing with createTestRegistry.
---

# Business logic with logic-sdk

Follow this exactly. Every module looks the same.

## Where things go

```
src/
  logic.ts       export const { query, mutation, action, event, listener, createRegistry } = init<Config>();   // Config's db: DrizzleDb<Db>, so queries can't write
  policies.ts    Scope type and policies: sync type guards over scope (anyone, member, admin)
  registry.ts    createRegistry({ modules: { bookings, ... } })   // only what this init() defined: another's is a type error
  rpc.ts         export const router = { bookings: { confirm: toORPCProcedure(bookings.confirm) } }   // the API: only what's listed is reachable
  <module>/
    index.ts       export * from each public file below. Other modules import ONLY this.
    queries.ts     query({...})     reads
    mutations.ts   mutation({...})  writes, one transaction (no nested ctx.db.transaction: its events would escape a rollback)
    actions.ts     action({...})    network calls: payments, email, AI, webhooks out
    events.ts      event({...})     things that happened
    listeners.ts   listener({...})  reacting to OTHER modules' events
    data.ts        private: helpers taking ctx (findBooking(ctx, id)), can* record checks, and private functions two files share. The index never re-exports it; other modules never import it.
    schema.ts      tables this module owns. Other modules never read them.
    <module>.test.ts
```

New module: create the folder, then add one line to `createRegistry({ modules })` in `src/registry.ts`.

## Writing a function

```ts
// policies.ts
export type Scope = SignedOutScope | MemberScope;                      // a union, so guards narrow it
export const anyone = () => true;
export const member = (s: Scope): s is MemberScope => s.actor !== null;
export const admin = (s: Scope): s is AdminScope => s.actor?.role === "admin";

// bookings/data.ts
export const canCancel = (actor: Actor, b: BookingRow) => actor.role === "admin" || b.createdBy === actor.id;

// bookings/mutations.ts
/** Cancel a booking and free its dates */
export const cancel = mutation({
  input: z.object({ bookingId: z.uuid() }),
  output: Booking,                                         // what callers may see: unknown fields stripped
  authorize: member,                                       // who may call it, on every call; narrows ctx.scope
  async handler(ctx, input) {
    const b = await findBooking(ctx, input.bookingId);     // account-scoped: other accounts' ids are 404
    if (!canCancel(ctx.scope.actor, b)) throw ctx.errors.deny();             // 403
    if (b.status === "cancelled") throw ctx.errors.reject("already_cancelled"); // code "bookings.already_cancelled"
    await ctx.run(availability.release, { sourceId: b.id }); // other module: through its index, with run()
    const updated = await setStatus(ctx, b.id, "cancelled");  // same module: a plain helper
    ctx.emit(cancelled, { bookingId: b.id });
    return updated;
  },
});
```

## Rules

1. **Pick the kind by what it touches.** Only reads: `query`. Writes to our database: `mutation`. Talks to the network: `action`. Reacts to another module: `listener`.
2. **Never put side effects in a mutation or query.** No email, HTTP or payments. They don't have `services` on purpose. Emit an event and react in a listener, or write an action that runs the mutation.
3. **Call other modules only with `run(otherModule.fn, input)`.** Import them as `import * as availability from "../availability"`. Never import their `data.ts` or `schema.ts`, from a module or from routes and pages.
4. **Within a module, use helpers.** Shared logic is a plain function in `data.ts` taking `ctx`. `ctx.run` your own module's function only when you want its `authorize`, validation and tracing. When an action must write, define the mutation in the action's own file without `export` and `ctx.run` it: nothing outside the file can reach it, so nothing can skip the action's checks. When two files need the same one, put it in `data.ts`, never in `mutations.ts`: exporting it from there for the other file makes `export * from "./mutations"` publish it. A private function can't be scheduled, published or run from a test: test it through the action (or the listener or cron whose handler runs it).
5. **Always filter by `ctx.scope.accountId`** in `data.ts` helpers, writes included. Loading helpers throw `ctx.errors.notFound()`. Scope is who and where (actor, account, locale); input is what.
6. **Authorize every function a user, client or AI tool may call.** `authorize: member` (a policy from `policies.ts`) says who may call it: sync, reads only scope, runs on every call including nested ones. Publish a function by listing it in `src/rpc.ts` (`toORPCProcedure(fn)`) or an agent's tools (`toAITool(caller, fn)`); both refuse one without `authorize`. A hand-written route or Server Action can `caller.run` anything, nothing stops it: only call functions that have `authorize` from them. Give published functions an `output` so nothing unintended leaves.
7. **Record rules are `can*` predicates.** Load through a scoped helper, then `if (!canX(ctx.scope.actor, record)) throw ctx.errors.deny();`. `can*` is sync, its result is always used, and the same predicate feeds UI flags in list queries: `can: { cancel: canCancel(actor, b) }`. A rule that must hold at commit goes in the write's `WHERE` or a `FOR UPDATE` re-select.
8. **Errors:** `throw ctx.errors.reject("snake_reason", details?)` when a rule says no, `ctx.errors.conflict(...)` when someone got there first, `ctx.errors.notFound()`, `ctx.errors.deny()`. Codes are namespaced to your module for you. Never return error objects; never throw plain `Error` for expected cases. Catch only in actions; in a mutation, catch only to rethrow your own error: nested mutations share the caller's transaction, so a caught failure fails the commit with an error naming both. Work over many rows where each must commit or fail alone (a cron over every account) `ctx.run`s the mutation per row inside `try`/`catch`, from a cron's handler or an action: never from a mutation.
9. **Need the result? `run` it. Just a consequence? `emit`** and let the owning module react in its `listeners.ts`.
10. **A listener that wants only some events says so with `when: (payload) => boolean`** (sync, from the payload only), instead of returning early in its handler: the others get no job. The emitter never filters for its listeners.
11. **Listeners must be idempotent** (record `ctx.event.id` per listener, since listeners of one event share it, and skip it if seen, when a repeat would charge or email twice). `ctx.emit` returns the event it queued (`{ id, name, payload, occurredAt }`): a row written in the same mutation can carry `event.id`, the id listeners see as `ctx.event.id`. They run with the emitter's scope (or the one `jobs.scope.load` rebuilds, when the app sets it), so they run internal functions. To act as someone else on purpose, pass the whole scope for that call: `ctx.run(fn, input, { scope: { ...ctx.scope, actor: system } })`. It's never merged, so it's always one of your scope's variants.
12. **Time** comes from `ctx.now()`, never `new Date()`, so tests can freeze it.
13. **Use separate `export const`s**, not functions nested in an object. Name them by verb within the module (`bookings.confirm`, not `bookings.confirmBooking`). Names are unique per module. Renaming a listener, event or function that queued jobs may still reference? Keep its id: `listener({ id: "oldName", ... })`. Put one sentence of JSDoc above each (`/** Cancel a booking and free its dates */`): editors show it on hover, and `logic-sdk list` prints it.
14. **`ctx` comes first, everywhere:** `handler(ctx, input)` in functions, `handler(ctx, payload)` in listeners, helpers `findBooking(ctx, id)`. A function that takes nothing leaves out `input`: `handler(ctx)`, called as `run(fn)`. A form's schema comes from the function it submits to (`properties.update.input.pick({ name: true })`), not from a schema the module exports.
15. **Settings come from `ctx.config`**, never from env inside a module. Declare its shape in `init<Config>()` (`config: { orders: { maxItems: number } }`), fill it from your env at the entry (`createRegistry({ config })`), and read it in any function: `ctx.config.orders.maxItems`. Plain data only. Clients built from secrets go in `services`. Outside modules (the entry, routes, scripts), read env however you like.
16. **Listeners that must not be lost run through a durable jobs adapter,** set once in `registry.ts`: `const database = drizzleAdapter(db)` from `logic-sdk/drizzle/pg` (SQLite: `drizzleAdapter(() => drizzle("app.db"))` from `logic-sdk/drizzle/sqlite`, the function, not a connection), then `createRegistry({ database: { adapter: database }, jobs: { adapter: databaseQueue(), scope: { store, load } } })` (your database is the queue, like Laravel's `database` driver; export `jobsTable` from the schema and sweep from a cron trigger or `startTicking`), `outbox(cloudflareQueue(env.JOBS))` when another queue runs them (the queue alone works too, and can lose a job on a crash), or `pgBoss(boss)` from `logic-sdk/pg-boss` when the app runs pg-boss (any database adapter that runs SQL) (`await boss.start()` in every process, `await work(registry, boss)` in the worker, `boss.stop()` on SIGTERM; tune a listener's queue and workers with `meta: { pgBoss: { queue, worker } }`, never its retries). `store` saves ids, `load` rebuilds the scope when the job runs, with today's roles (`null` discards it: check membership there). `createRegistry` requires `load` with every adapter but `inProcess()`; keep the `system` field of a system scope in both. Never pass a jobs adapter per module, and never enqueue background work by hand from a mutation: `emit` an event. A listener tries once; give it `attempts: 5` when retrying is safe (`inProcess()` refuses attempts above 1: it runs each job once), and `delay: 60` (seconds) to run it later.
17. **Scheduled work is a `cron`,** a listener for the clock, exported from the module: `cron({ schedule: "0 9 * * MON", scope: { kind: "system", job: "reports.weekly" }, async handler(ctx) { await ctx.run(fn) } })`, where `scope` is a system variant of the app's own `Scope` (its own `kind` and the job's name, never built from a request; the library defines no scope fields) and policies grant it explicitly (`staffOrSystem`), never a fake user. With `jobs.scope`, `store` and `load` must keep the system variant: what a cron emits or schedules is stored like anything else. Five-field strings only (weekdays as names: Cloudflare numbers them from Sunday = 1), `timezone` when it isn't UTC. The handler gets an action's ctx plus `ctx.cron` (`scheduledAt`: the minute the run is for; `attempt`), and `ctx.scope` typed as the declared scope; every `ctx.run` checks that function's policy against it. Name a cron after its work, like a listener (`sendDigest`); one that runs shared work, after when it runs (`nightly`). A retry reruns the whole handler: make it idempotent, and put all-or-nothing work in one `ctx.run(mutation)`. `meta` like a listener's (`meta.pgBoss` tunes its queue). On Node, `startTicking(registry)` from `logic-sdk/node` ticks and sweeps (`await stop()` on SIGTERM); with pg-boss, `work(registry, boss)` ticks them; on Cloudflare, `handleScheduled` from a `"* * * * *"` trigger (weekdays as names in `wrangler.jsonc`: Cloudflare counts Sunday as 1). Test with `t.jobs.tick(at)` (every cron due that minute) or `t.jobs.perform(cron, { at })` (that one, due or not).
18. **Work for later is `ctx.schedule(fn, input, { at } | { delay })`,** from a mutation only, so it commits with it (actions and listeners run a mutation that schedules). It returns nothing, and there's no cancel: your row is the truth. Cancelling a booking writes `status: "cancelled"`, and the function checks its reason when it runs, in the same transaction as its effect (`update ... where status = 'confirmed' and reminder_sent_at is null returning id`; nothing returned, so `return`). Like a cron's, it can run twice, mutations included, so make it idempotent (a unique key and `onConflictDoNothing()`). One try by default: add `attempts: 3` for an action that calls an API. When what it's for can change (a booking's dates), pass `replace: true`: a newer call to the same function with the same input replaces the waiting one, so it doesn't run twice. Keep the input to ids (`{ bookingId }`), so it names one thing. To run it as someone else, pass the whole scope: `{ at, scope: { kind: "system", job: "tasks.wake", organization } }`. It needs `jobs: { adapter: databaseQueue(), scope: { store, load } }`, an `outbox` or `pgBoss(boss)` (rule 16); tests read `t.jobs.scheduled` and run it with `t.jobs.drain({ until })`.
19. **Failed jobs and run-now are for operators,** outside functions, in scripts and staff routes you guard with your own policy: `registry.jobs.failed({ source: "emails.send", scope: { organizationId }, cursor })` (newest first; `scope` matches what `store` saved), then `retry(id)` or `forget(id)` each (a queue on its own keeps them in `jobs: { failed: failedJobs() }`); `registry.jobs.invoke(orders.sendDigest)` runs a cron now (`{ at }` for a missed minute). A user never retries a job: what they want again is a mutation that checks your row and emits again.

## Tests

```ts
const mailer = memoryMailer();
const t = createTestRegistry(registry, {
  services: { mailer },
  now: "2026-07-01T10:00:00Z",
  config: { orders: { maxItems: 1 } },          // any part of config; merged over the registry's
});
beforeEach(async () => {
  mailer.sent.length = 0;                       // fresh memory services per test
  await t.begin();                              // each test in a transaction that's rolled back
});
afterEach(() => t.rollback());

test("cancel frees the dates", async () => {
  const agent = t.as(scopeAs("agent"));
  // arrange with real functions, not inserts
  // act: await agent.run(bookings.cancel, { bookingId })
  // assert on rows (t.db), t.events, and memory services
});
```

- Use the real database. Don't mock modules. If you must simulate a failure elsewhere: `t.stub(availability.hold, async () => { throw … })`.
- A failing listener makes `run` throw in tests. `createTestRegistry(registry, { jobs: "manual" })` keeps jobs in `t.jobs.queued` to test one module alone; `t.jobs.drain()` runs them, `t.jobs.perform(listener, payload, { scope })` runs one.
- Test the deny path: another account's id is `not_found`, a caller who fails `authorize` or `can*` is `forbidden`.

## Done means

`tsc` passes and the tests pass. Every new mutation has a test for its main rule.

Before changing a function, look it up: `logic-sdk show bookings.confirm --json` gives its schemas, policy, record checks, what it runs and emits, and who calls it. `logic-sdk graph --module bookings` shows a module's connections.
