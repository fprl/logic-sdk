# Roadmap (Nov 2026)

What's done, what's next, and what's known to be missing. Decisions and their reasons live in DESIGN.md.

## Positioning

- **One line:** queries, mutations, actions and events for TypeScript. One shape for every context, enforced, on any framework and runtime.
- **The honest claim:** no TS library we found combines all of these without tying you to a framework (NestJS), its own database (Convex) or a compiler (Wasp):
  - safe nested failures
  - events delivered only after commit
  - an outbox seam
  - a typed scope
  - internal by default
- **Don't claim "unique dooming".** Convex, Effect and Laravel also handle nested failures safely, with sub-transactions or savepoints. Only Rails commits partial writes when a caught error is ignored.
- **Don't headline durability** until an outbox ships. Lead with the conventions, the test story and AI-legibility.
- **Not Rails.** It's the business-logic layer only. Hono, Drizzle, Better Auth and the rest stay the user's choice.
- **The layer under the framework:** "the Data Access Layer Next.js tells you to write, as a library." Redwood and Blitz died on host coupling.
- **Adoptable one mutation at a time.** No DDD vocabulary in the API or docs.
- **Before publishing the claim,** check DBOS Transact, Effect with `@effect/sql`, and Emmett once more. Closest found so far: noddde, Kumiko, AdonisJS.

## Done

- **API:** `query`/`mutation`/`action`/`on`; `expose` with named policies that narrow the scope and run on every call; curried `init<Config>()({ policies })`; lazy `on(() => event)`; helpers take `ctx`; `createRegistry({ modules })` and `registry.as(scope)`.
- **Transactions:** validation and the policy check before the transaction opens; transaction state per attempt; lost races retried (40001/40P01, 3 attempts with jitter).
- **Errors:** `ctx.reject`/`conflict`/`notFound`/`deny`, namespaced per module; `unauthenticated()` at the edge; six kinds, no HTTP in core.
- **Contracts:** `outputSchema` required on exposed functions; typed `meta` per function, visible in `wrap`.
- **Events:** loop limit 8; `emit` snapshots its payload.
- **Agents:** `toAITools` (`logic-sdk/ai`) and `examples/nextjs`, where a Server Action and an agent call the same `bookings.confirm`.
- **CLI v0.1** (`@logic-sdk/cli`): `list`, `show`, `graph`, `check`, `--json`, read-only. Stricli for commands, jiti to load the app, oxc to read the source, zero-dependency rendering.
- **Node 26 LTS** required everywhere (Temporal is built in).
- **Repo:** Bun workspaces like files-sdk; `bun test` for core; `examples/node` (Vitest, PGlite or real Postgres with `DATABASE_URL`, a real race test) and `examples/workers` (Vitest in workerd, Hyperdrive); docs site on Blume; oxlint repo-wide.

## Next

**Before the first publish**

1. Claim `logic-sdk` and the `@logic-sdk` scope on npm.
2. git and GitHub, then `repository`, `homepage` and `bugs` in `package.json`, and CI and changesets publishing switched on (first publish by hand, then npm trusted publishing).

**The CLI** (`@logic-sdk/cli`, loads `src/registry.ts`)

3. CLI v0.2: `run bookings.confirm '{…}' --as agent`, rolled back by default (`--commit` to keep it); follow `run` calls inside helpers; warn on event cycles.
4. CLI later: `init`, `add module`, `inspect` (a live tree of calls built on `wrap`).

## Later

- **Durable events.** A Postgres outbox dispatcher (~60 lines) with a crash test, then adapters for Workflow DevKit and queues. It must fix two known gaps first:
  - the loop limit is lost on the durable path: `dispatch` starts at depth 1 and `Envelope` has no depth field
  - `dispatch` is all-or-nothing: one failing listener makes the healthy ones re-run on retry (dispatch per listener instead)
- **Listener timeout.** Delivery is serial with no timeout.
- **Jobs and a scheduler** (ActiveJob, Laravel queues): `schedule(fn, input, { at })` from mutations, and a cron list. Through the dispatcher contract below.
- **Test helpers** (Laravel `Mail::fake()`, Rails `travel_to`): `expectEmitted`, `tx.advance("1h")`, `tx.drain()`.
- **Opt-in savepoint `run`** for "try, and continue on failure" (e.g. coupons). `nest` already exists in the Drizzle adapter.
- **A second database adapter** (Kysely or Prisma) before 1.0.
- **Skills** in the package via TanStack Intent, and `logic-sdk init` (logic.ts, registry.ts, lint config, AGENTS.md).
- **Seeds:** a docs recipe, not a feature. A seed script calls real mutations through `registry.as(scope)`.
- Turbo if build caching starts to matter, tsdown only if CJS is needed, oxfmt, deploying apps/web.

Skipped: model callbacks and observers (we chose explicit), notifications, caching, broadcasting, soft deletes, a REPL console.

## Dispatcher contract

- `enqueue(tx, envelopes)` inside the transaction, `registry.dispatch(envelope)` from any worker (throws if a listener failed, so the worker retries).
- **Transactional queues** (pg-boss, Graphile Worker): enqueue in the same transaction. **External queues** (Inngest, Trigger.dev, SQS, Cloudflare Queues): an outbox table plus a relay.
- Tests use the in-memory dispatcher, so they're the same whatever production uses.
- Every adapter (database and dispatcher) runs a shipped conformance suite.

## Open

- **Tenancy sugar (maybe):** a typed `owned(table)` condition in `logic-sdk/drizzle`, bound to the scope, that fails to compile on tables without `accountId`. Sugar only.
- **Scope in envelopes** stores actor data at rest and replays stale roles later. Consider a projection hook for events.
- **Top-level queries** read outside a transaction, so a query with several selects can see different snapshots. A `READ ONLY` transaction flag on the adapter would fix it.
- **A typed proxy** (`caller.bookings.confirm(input)`) as sugar over `run`, after a type-cost prototype.

## Sources

- Convex: [runtimes](https://docs.convex.dev/functions/runtimes), [OCC](https://docs.convex.dev/database/advanced/occ), [actions](https://docs.convex.dev/functions/actions), [scheduling](https://docs.convex.dev/scheduling/scheduled-functions), [application errors](https://docs.convex.dev/functions/error-handling/application-errors)
- Frameworks: [Rails transactions](https://api.rubyonrails.org/classes/ActiveRecord/Transactions/ClassMethods.html), [Rails rescue_responses](https://guides.rubyonrails.org/configuring.html), [Laravel transactions](https://laravel.com/docs/database#database-transactions), [Laravel errors](https://laravel.com/docs/errors), [Ecto.Repo](https://ecto.hexdocs.pm/Ecto.Repo.html), [Oban](https://hexdocs.pm/oban/Oban.html), [Postgres isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- RPC: [tRPC metadata](https://trpc.io/docs/server/metadata), [oRPC metadata](https://orpc.dev/docs/metadata), [oRPC errors](https://orpc.dev/docs/error-handling), [AI SDK tool()](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool)
- Platforms: [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Hyperdrive with postgres.js](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/), [Vercel waitUntil](https://vercel.com/changelog/waituntil-is-now-available-for-vercel-functions)
- Comparables: [NestJS outbox](https://docs.nestjs.com/reliability/outbox), [DBOS](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial), [pg-boss](https://github.com/timgit/pg-boss)
- Boundaries: [Packwerk](https://github.com/Shopify/packwerk/blob/main/USAGE.md), [Elixir boundary](https://boundary.hexdocs.pm/Boundary.html), [dependency-cruiser](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)
- Tooling: [TanStack Intent](https://tanstack.com/intent/latest/docs/overview), [Stately Inspector](https://stately.ai/blog/2024-01-15-introducing-stately-inspector), [files-sdk repo](https://github.com/haydenbleasel/files-sdk)
