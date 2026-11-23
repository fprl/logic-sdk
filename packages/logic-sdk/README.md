# Logic SDK

**Business logic for TypeScript apps, as queries, mutations, actions, events, jobs and crons.**

Write the layer between your routes and your database once, as plain declarations. Call it from an HTTP route, a Server Action, a queue worker, a script, a test or an AI agent: same rules, same transaction, same events.

## Install

```bash
npm i logic-sdk zod
```

Node 24+, Bun or Cloudflare Workers. Postgres or SQLite on a disk for mutations, through Drizzle or any ORM that can run SQL in a transaction.

## Quick start

Declare your types once, and who may do what:

```ts
// src/logic.ts
export const { query, mutation, action, event, listener, createRegistry } = init<Config>();

// src/policies.ts: sync type guards over the scope
export const anyone = () => true;
export const member = (s: Scope): s is MemberScope => s.actor !== null;
export const staff = (s: Scope): s is StaffScope => s.actor !== null && s.actor.role !== "guest";
```

Write a module:

```ts
// src/bookings/mutations.ts
/** Confirm a pending booking */
export const confirm = mutation({
  input: z.object({ bookingId: z.uuid() }),
  output: Booking,
  // Who may call it, on every call
  authorize: staff,

  async handler(ctx, input) {
    const booking = await findBooking(ctx, input.bookingId);
    if (booking.status !== "pending") {
      throw ctx.errors.reject("not_pending");
    }

    // Another module, in the same transaction
    await ctx.run(availability.hold, rangeOf(booking));

    // Delivered to listeners only after commit
    ctx.emit(confirmed, { bookingId: input.bookingId });

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

Work that must not be lost goes through a jobs adapter. Listeners, scheduled calls and crons all use it:

```ts
const database = drizzleAdapter(db);

export const registry = createRegistry({
  modules: { bookings, availability },
  database,
  jobs: { adapter: databaseQueue(database), scope: { store, load } },
});

// a listener, with tries
export const sendConfirmation = listener({ event: () => confirmed, attempts: 3, handler });

// a cron
export const morningDigest = cron({ schedule: "0 8 * * MON-FRI", run: () => sendDigest, scope: asSystem("digest") });

// later, from a mutation, committed with it
ctx.schedule(remindGuest, { bookingId }, { at: dayBefore(booking.checkIn) });
```

## What you get

- **One transaction across modules.** A failure anywhere rolls back everything, even if someone catches it.
- **Side effects after commit.** Mutations emit events; listeners send the email once the data is safe.
- **Jobs, four ways.** Your Postgres as the queue (`databaseQueue`), Cloudflare Queues alone, an outbox in front of a queue, or pg-boss. All but in-process can run a job twice, so make them idempotent.
- **Lost races retried.** Deadlocks and serialization failures re-run the mutation in a fresh transaction: three tries, or `drizzleAdapter(db, { transactionAttempts })`.
- **Who is calling, everywhere.** The scope reaches every nested call and listener, and policies narrow its type.
- **Authorization on every call.** `authorize` runs whoever calls: HTTP, an agent, a job or another function. Record rules are sync `can*` predicates the CLI checks.
- **Internal by default.** A function reaches clients only when you publish it: in your oRPC router or an agent's tools, which refuse one without `authorize`, or from your own route, which should only call functions that have one.
- **Agents included.** `toAITool` gives an agent your functions, under the same policies and transactions as your API, one function at a time.
- **Settings in one place.** Declare `config` once, fill it from env at the entry, read `ctx.config` anywhere. The CLI fails the build if a module reads env.
- **Errors without HTTP.** `ctx.errors.reject`, `conflict`, `notFound`, `deny`; adapters map them to statuses.
- **Tests without mocks.** Each test is a real transaction on a real database, always rolled back.
- **No magic.** No decorators, classes, codegen, build step or `AsyncLocalStorage`.

## Adapters

| Import | |
|---|---|
| `logic-sdk/drizzle/pg` | The database adapter, `databaseQueue` and `outbox` |
| `logic-sdk/postgres` | `databaseQueue` and `outbox` on Postgres with any ORM |
| `logic-sdk/drizzle/sqlite` | The same on SQLite: `drizzleAdapter(() => drizzle("app.db"))` |
| `logic-sdk/sqlite` | `databaseQueue` and `outbox` on SQLite with any ORM |
| `logic-sdk/cloudflare` | Cloudflare Queues and Cron Triggers |
| `logic-sdk/pg-boss` | Jobs in pg-boss |
| `logic-sdk/node` | `startTicking`: crons and sweeps in a long-running process |
| `logic-sdk/fetch` | `toResponse`: a domain error as an HTTP response, for your own routes |
| `logic-sdk/orpc` | `toORPCProcedure`: a function as an oRPC v2 procedure, for your router |
| `logic-sdk/ai` | AI SDK tools: agents run your functions with the same rules |
| `logic-sdk/testing` | Rolled-back test transactions, stubs, frozen time |

## CLI

```bash
npm i -D @logic-sdk/cli
npx logic-sdk list                   # every function, its kind and policy
logic-sdk show bookings.confirm      # schemas, what it runs and emits, who calls it
logic-sdk graph --format mermaid     # who runs whom, who reacts to which event
logic-sdk check                      # module boundaries, mutation/action cycles, no network in transactions, can* checks
```

Read-only, `--json` everywhere, exit codes for CI. The `logic-sdk` command ships with the main package and hands off to `@logic-sdk/cli`, so apps that don't use the CLI never download it.

## Examples

- [`examples/shop`](examples/shop): start here. A shop written once and run on Node, Cloudflare Workers and Next.js, with an AI assistant.
- [`examples/bookings`](examples/bookings): a bigger app. Six modules, Hono, Postgres, and a race test on real Postgres.

## Docs

The docs site lives in [`apps/web`](apps/web) (`bun run --filter web dev`). Start with the [introduction](apps/web/docs/index.mdx) and the [quickstart](apps/web/docs/02-quickstart.mdx). The agent skill, [`skills/logic-sdk/SKILL.md`](packages/logic-sdk/skills/logic-sdk/SKILL.md), ships in the package: the short version for coding agents.

## Repository

```bash
bun install
bun run test    # build, typecheck, lint, package checks, all tests
```

`packages/logic-sdk` is the library, tested with `bun test`. `examples/bookings` runs on PGlite by default and on real Postgres with `DATABASE_URL` (`bun run test:pg`), which CI always sets. `examples/shop` also runs its Worker inside workerd. Decisions and their reasons are in [DESIGN.md](DESIGN.md); what's next is in [ROADMAP.md](ROADMAP.md).

## License

MIT
