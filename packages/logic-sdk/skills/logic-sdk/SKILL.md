---
name: logic-sdk
description: Write and change business logic with logic-sdk (queries, mutations, actions, events, listeners, policies, modules, tests). Use when adding a module or function, wiring createRegistry, writing authorize policies or can* checks, emitting events, or testing with createTestRegistry.
---

# Business logic with logic-sdk

Follow this exactly. Every module looks the same.

## Where things go

```
src/
  logic.ts       export const { query, mutation, action, event, listener, createRegistry } = init<Config>();
  policies.ts    Scope type and policies: sync type guards over scope (anyone, member, admin)
  registry.ts    createRegistry({ modules: { bookings, ... } })
  <module>/
    index.ts       export * from each public file below. Other modules import ONLY this.
    queries.ts     query({...})     reads
    mutations.ts   mutation({...})  writes, one transaction
    actions.ts     action({...})    network calls: payments, email, AI, webhooks out
    events.ts      event({...})     things that happened
    listeners.ts   listener({...})  reacting to OTHER modules' events
    data.ts        private helpers taking ctx (findBooking(ctx, id)) and can* record checks. Never imported by other modules.
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
  output: Booking,                                         // required with expose: what callers may see
  authorize: member,                                       // who may call it, on every call; narrows ctx.scope
  expose: true,                                            // adapters may publish it; omit = internal
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
3. **Call other modules only with `run(otherModule.fn, input)`.** Import them as `import * as availability from "../availability"`. Never import their `data.ts` or `schema.ts`, from a module or from routes and pages; `logic-sdk check` fails the build if you do (path aliases and `#` imports included).
4. **Within a module, use helpers.** Shared logic is a plain function in `data.ts` taking `ctx`. `ctx.run` your own module's function only when you want its `authorize`, validation and tracing.
5. **Always filter by `ctx.scope.accountId`** in `data.ts` helpers, writes included. Loading helpers throw `ctx.errors.notFound()`. Scope is who and where (actor, account, locale); input is what.
6. **Authorize every function a user, client or AI tool may call.** `authorize: member` (a policy from `policies.ts`) says who may call it: sync, reads only scope, runs on every call including nested ones. `expose: true` lets adapters publish it and requires `authorize` and `output`. No `expose` = internal: only your code calls it.
7. **Record rules are `can*` predicates.** Load through a scoped helper, then `if (!canX(ctx.scope.actor, record)) throw ctx.errors.deny();`. `can*` is sync, its result is always used, and the same predicate feeds UI flags in list queries: `can: { cancel: canCancel(actor, b) }`. A rule that must hold at commit goes in the write's `WHERE` or a `FOR UPDATE` re-select.
8. **Errors:** `throw ctx.errors.reject("snake_reason", details?)` when a rule says no, `ctx.errors.conflict(...)` when someone got there first, `ctx.errors.notFound()`, `ctx.errors.deny()`. Codes are namespaced to your module for you. Never return error objects; never throw plain `Error` for expected cases. Catch only in actions; in a mutation, catch only to rethrow your own error.
9. **Need the result? `run` it. Just a consequence? `emit`** and let the owning module react in its `listeners.ts`.
10. **Listeners must be idempotent** (record `ctx.event.id` and skip it if seen, when a repeat would charge or email twice). They run with the emitter's scope (or the one `jobs.scope.load` rebuilds, when the app sets it), so they run internal functions. To act as someone else on purpose, change the scope for that call: `ctx.run(fn, input, { scope: { actor: system } })`.
11. **Time** comes from `ctx.now()`, never `new Date()`, so tests can freeze it.
12. **Use separate `export const`s**, not functions nested in an object. Name them by verb within the module (`bookings.confirm`, not `bookings.confirmBooking`). Names are unique per module. Renaming a listener, event or function that queued jobs may still reference? Keep its id: `listener({ id: "oldName", ... })`. Put one sentence of JSDoc above each (`/** Cancel a booking and free its dates */`): editors show it on hover, and `logic-sdk list` prints it.
13. **`ctx` comes first, everywhere:** `handler(ctx, input)` in functions, `handler(ctx, payload)` in listeners, helpers `findBooking(ctx, id)`. A function that takes nothing leaves out `input`: `handler(ctx)`, called as `run(fn)`.
14. **Settings come from `ctx.config`**, never from env inside a module. Declare its shape in `init<Config>()` (`config: { orders: { maxItems: number } }`), fill it from your env at the entry (`createRegistry({ config })`), and read it in any function: `ctx.config.orders.maxItems`. Plain data only. Clients built from secrets go in `services`. Outside modules (the entry, routes, scripts), read env however you like; `logic-sdk check` fails on env reads inside modules, including through files they import.
15. **Listeners that must not be lost run through a durable jobs adapter,** set once in `registry.ts`: `createRegistry({ jobs: { adapter: outbox(db), scope: { store, load } } })`. `store` saves ids, `load` rebuilds the scope when the job runs (`null` discards it). Never pass a jobs adapter per module, and never enqueue background work by hand from a mutation: `emit` an event. A listener tries once; give it `attempts: 5` when retrying is safe, and `delay: 60` (seconds) to run it later.
16. **Scheduled work is a `cron`,** exported from the module like a listener: `cron({ schedule: "0 9 * * 1", run: fn, scope: system })`, five-field strings only, `timezone` when it isn't UTC. `run` is an existing function (it keeps its policy); never put the work in the cron itself. The app calls `registry.jobs.tick()` every minute (or `handleScheduled` on Cloudflare); test with `t.jobs.tick(at)`.

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

`tsc` passes, `logic-sdk check` passes (module boundaries, run cycles, no network in transactions, `can*` checks sync and used), and the tests pass. Every new mutation has a test for its main rule.

Before changing a function, look it up: `logic-sdk show bookings.confirm --json` gives its schemas, policy, record checks, what it runs and emits, and who calls it. `logic-sdk graph --module bookings` shows a module's connections.
