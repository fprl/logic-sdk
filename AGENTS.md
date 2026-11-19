# AGENTS.md: business logic with logic-sdk

Copy this into your app's AGENTS.md. Follow it exactly. Every module looks the same.

## Where things go

```
src/<module>/
  index.ts       export * from each public file below. Other modules import ONLY this.
  queries.ts     query({...})     reads
  mutations.ts   mutation({...})  writes, one transaction
  actions.ts     action({...})    network calls: payments, email, AI, webhooks out
  events.ts      event({...})     things that happened
  listeners.ts   on(() => other.event, ...)   reacting to OTHER modules' events
  data.ts        private helpers taking ctx: findBooking(ctx, id). Never imported by other modules.
  schema.ts      tables this module owns. Other modules never read them.
  <module>.test.ts
```

New module: create the folder, then add one line to `createRegistry({ modules })` in `src/registry.ts`.

## Writing a function

```ts
export const cancel = mutation({
  description: "Cancel a booking and free its dates",     // one sentence, shown to humans, adapters and AI tools
  inputSchema: z.object({ bookingId: z.uuid() }),
  outputSchema: Booking,                                   // required when exposed: what callers may see
  expose: "staff",                                         // a policy from logic.ts; omit = internal (never published)
  async execute({ bookingId }, ctx) {
    const b = await findBooking(ctx, bookingId);
    if (b.status === "cancelled") throw ctx.reject("already_cancelled"); // code "bookings.already_cancelled"
    await ctx.run(availability.release, { sourceId: b.id }); // other module: through its index, with run()
    const updated = await setStatus(ctx, b.id, "cancelled");
    ctx.emit(cancelled, { bookingId: b.id });
    return updated;
  },
});
```

## Rules

1. **Pick the kind by what it touches.** Only reads: `query`. Writes to our database: `mutation`. Talks to the network: `action`. Reacts to another module: `on`.
2. **Never put side effects in a mutation or query.** No email, HTTP or payments. They don't have `services` on purpose. Emit an event and react in a listener, or write an action that runs the mutation.
3. **Call other modules only with `run(otherModule.fn, input)`.** Import them as `import * as availability from "../availability"`. Never import their `data.ts` or `schema.ts`; the linter fails the build if you do.
4. **Always filter by `ctx.scope.accountId`** in `data.ts` helpers, writes included. Scope is who and where (actor, account, locale); input is what.
5. **Errors:** `throw ctx.reject("snake_reason", details?)` when a rule says no, `ctx.conflict(...)` when someone got there first, `ctx.notFound()`, `ctx.deny()`. Codes are namespaced to your module for you. Never return error objects; never throw plain `Error` for expected cases. Catch only in actions; in a mutation, catch only to rethrow your own error.
6. **Need the result? `run` it. Just a consequence? `emit`** and let the owning module react in its `listeners.ts`.
7. **Listeners must be idempotent.** They may run again later (use `event.id` to dedupe when it matters).
8. **Expose on purpose, with an `outputSchema`.** Only functions a user, client or AI tool may call get `expose`. Their policy runs on every call, nested ones too. To act as someone else, change who: `ctx.with({ actor }).run(...)`.
9. **Time** comes from `ctx.now()`, never `new Date()`, so tests can freeze it.
10. **Use separate `export const`s**, not functions nested in an object. Name them by verb within the module (`bookings.confirm`, not `bookings.confirmBooking`). Names are unique per module.

## Tests

```ts
const t = createTestRegistry(registry, { services: { mailer: memoryMailer() }, now: "2026-07-01T10:00:00Z" });

test("cancel frees the dates", () => t.transaction(async (tx) => {
  const agent = tx.as(scopeAs("agent"));
  // arrange with real functions, not inserts
  // act: await agent.run(bookings.cancel, { bookingId })
  // assert on rows (tx.db), tx.events, and memory services
}));
```

- Use the real database. Don't mock modules. If you must simulate a failure elsewhere: `tx.stub(availability.hold, async () => { throw … })`.
- `createTestRegistry(registry, { listeners: false })` tests one module without the others reacting.

## Done means

`tsc` passes, `logic-sdk check` passes (module boundaries, run cycles, no network in transactions), and the tests pass. Every new mutation has a test for its main rule.

Before changing a function, look it up: `logic-sdk show bookings.confirm --json` gives its schemas, policy, what it runs and emits, and who calls it. `logic-sdk graph --module bookings` shows a module's connections.
