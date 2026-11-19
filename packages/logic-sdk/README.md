# Logic SDK

**Business logic for TypeScript apps, as queries, mutations, actions and events.**

Write the layer between your routes and your database once, as plain declarations. Call it from an HTTP route, a Server Action, a queue worker, a script, a test or an AI agent: same rules, same transaction, same events.

## Install

```bash
npm i logic-sdk zod
```

Node 24+, Bun or Cloudflare Workers. Postgres through Drizzle for mutations.

## Quick start

Declare your types once, and who may do what:

```ts
// src/logic.ts
export const { query, mutation, action, event, on, createRegistry } = init<Config>();

// src/policies.ts: sync type guards over the scope
export const anyone = () => true;
export const member = (s: Scope): s is MemberScope => s.actor !== null;
export const staff = (s: Scope): s is StaffScope => s.actor !== null && s.actor.role !== "guest";
```

Write a module:

```ts
// src/bookings/mutations.ts
export const confirm = mutation({
  description: "Confirm a pending booking",
  inputSchema: z.object({ bookingId: z.uuid() }),
  outputSchema: Booking,
  // Who may call it, on every call
  authorize: staff,
  // HTTP, oRPC and AI tools may publish it
  expose: true,

  async execute({ bookingId }, ctx) {
    const booking = await findBooking(ctx, bookingId);
    if (booking.status !== "pending") {
      throw ctx.errors.reject("not_pending");
    }

    // Another module, in the same transaction
    await ctx.run(availability.hold, rangeOf(booking));

    // Delivered to listeners only after commit
    ctx.emit(confirmed, { bookingId });

    return setStatus(ctx, booking.id, "confirmed");
  },
});
```

Register your modules and call them from anywhere:

```ts
// src/registry.ts
export const registry = createRegistry({
  modules: { bookings, availability },
  database: drizzleAdapter(db),
  services: { mailer, payments },
});

// a route, a job, a script, a test
const caller = registry.as({ actor, accountId });
await caller.run(bookings.confirm, { bookingId });
```

## What you get

- **One transaction across modules.** A failure anywhere rolls back everything, even if someone catches it.
- **Side effects after commit.** Mutations emit events; listeners send the email once the data is safe.
- **Lost races retried.** Deadlocks and serialization failures re-run the mutation in a fresh transaction.
- **Who is calling, everywhere.** The scope reaches every nested call and listener, and policies narrow its type.
- **Authorization on every call.** `authorize` runs whoever calls: HTTP, an agent, a job or another function. Record rules are sync `can*` predicates the CLI checks.
- **Internal by default.** Only `expose: true` functions reach HTTP, RPC or AI tools, with a required policy and output contract.
- **Agents included.** `toAITool` gives an agent your functions, under the same policies and transactions as your API. Opt-in, one function at a time or by `filter`.
- **Settings in one place.** Declare `config` once, fill it from env at the entry, read `ctx.config` anywhere. The CLI fails the build if a module reads env.
- **Errors without HTTP.** `ctx.errors.reject`, `conflict`, `notFound`, `deny`; adapters map them to statuses.
- **Tests without mocks.** Each test is a real transaction on a real database, always rolled back.
- **No magic.** No decorators, classes, codegen, build step or `AsyncLocalStorage`.

## Adapters

| Import | |
|---|---|
| `logic-sdk/drizzle` | The database adapter |
| `logic-sdk/fetch` | A web-standard HTTP handler for exposed functions |
| `logic-sdk/orpc` | A typed oRPC v2 router and client |
| `logic-sdk/ai` | AI SDK tools: agents run your functions with the same rules |
| `logic-sdk/testing` | Rolled-back test transactions, stubs, frozen time |

## CLI

```bash
npm i -D @logic-sdk/cli
npx logic-sdk list                   # every function, its kind and policy
logic-sdk show bookings.confirm      # schemas, what it runs and emits, who calls it
logic-sdk graph --format mermaid     # who runs whom, who reacts to which event
logic-sdk check                      # module boundaries, run cycles, no network in transactions, can* checks
```

Read-only, `--json` everywhere, exit codes for CI. The `logic-sdk` command ships with the main package and hands off to `@logic-sdk/cli`, so apps that don't use the CLI never download it.

## Examples

- [`examples/shop`](examples/shop): start here. A shop written once and run on Node, Cloudflare Workers and Next.js.
- [`examples/node`](examples/node): a bookings app. Six modules, Hono, Postgres, and a race test on real Postgres.
- [`examples/workers`](examples/workers): a link shortener on Cloudflare Workers, Hyperdrive and `waitUntil`.
- [`examples/nextjs`](examples/nextjs): a Server Action and an AI agent calling the same `bookings.confirm`.

## Docs

The docs site lives in [`apps/web`](apps/web) (`bun run --filter web dev`). Start with the [introduction](apps/web/docs/index.mdx) and the [quickstart](apps/web/docs/02-quickstart.mdx). [`AGENTS.md`](AGENTS.md) is the short version for coding agents.

## Repository

```bash
bun install
bun run test    # build, typecheck, lint, package checks, all tests
```

`packages/logic-sdk` is the library, tested with `bun test`. `examples/node` runs on PGlite by default and on real Postgres with `DATABASE_URL` (`bun run test:pg`), which CI always sets. `examples/workers` runs inside workerd. Decisions and their reasons are in [DESIGN.md](DESIGN.md); what's next is in [ROADMAP.md](ROADMAP.md).

## License

MIT
