# Roadmap (Nov 2026)

What's done, what's next, and what's known to be missing. Decisions and their reasons live in DESIGN.md; how Rails, Laravel, Phoenix and the JS platforms do the same things lives in RESEARCH.md.

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

- **API (0.2.0):** `query`/`mutation`/`action`/`on`; `authorize: policy` (sync, scope-only, narrows, runs on every call) plus `expose: true`; record rules as sync `can*` checks in the handler; single-call `init<Config>()`; lazy `on(() => event)`; helpers take `ctx`; `createRegistry({ modules })` and `registry.as(scope)`.
- **Transactions:** the policy check and validation before the transaction opens (policy first); transaction state per attempt; lost races retried (40001/40P01, 3 attempts with jitter).
- **Errors:** `ctx.errors.reject`/`conflict`/`notFound`/`deny`, namespaced per module; `unauthenticated()` in `logic-sdk/fetch`; six kinds, no HTTP in core; bad input on a nested call is a bug (500).
- **Contracts:** `output` required on exposed functions; typed `meta` per function, visible in `wrap`.
- **Events:** loop limit 8; `emit` snapshots its payload.
- **Agents:** `toAITool` and `toAITools` with a required `filter` (`logic-sdk/ai`) The shop's Next.js host gives an assistant two functions as tools.
- **CLI v0.1** (`@logic-sdk/cli`): `list`, `show`, `graph`, `check`, `--json`, read-only. Stricli for commands, jiti to load the app, oxc to read the source, zero-dependency rendering.
- **Node 24 and 26** supported by the packages (CI runs both); the repo develops on 26.
- **Config and run options (0.3.0):** `ctx.config` (declared in `init`, filled at the entry, frozen, overridable per test) and `run(fn, input, { scope, signal })`; the CLI's `env-in-module` rule.
- **`input`/`output`/`handler(ctx, input)` (0.4.0):** names from app-logic libraries, ctx first everywhere, optional `input` and `run(fn)`, events declare `payload`.
- **Unreleased:** `listener({ event: () => placed, meta, handler })` replaces `on(...)`; `description` is gone (JSDoc for humans, `meta.ai.description` for tools); the agent skill ships in the package; `query`/`mutation`/`action` have one typed signature instead of five overloads (clearer errors, same type-check speed).
- **Published:** `logic-sdk` and `@logic-sdk/cli` on npm through trusted publishing from github.com/fprl/logic-sdk.
- **Repo:** Bun workspaces like files-sdk; `bun test` for core; `examples/shop` (one app on Node, Workers and Next.js; its Worker tested in workerd) and `examples/bookings` (six modules; Vitest, PGlite or real Postgres with `DATABASE_URL`, a real race test); docs site on Blume; oxlint repo-wide.

## Before 0.5.0

Agreed with the owner, collected from every conversation up to 2026-11-22. Don't move one to "later" without asking them. An item marked API is shown as code before it's built.

1. **The SQL seam for other ORMs (API).** The jobs table written once per database in SQL, behind one `query(client, text, params)` on the database adapter. Drizzle keeps `databaseQueue(db)` and its re-exported table, others get the SQL for their migrations. Prototyped: the whole suite passes on it, and one scenario list passes on Drizzle (PGlite, postgres.js, node-postgres) and a Prisma-shaped client.
2. **SQLite, plain (API).** node:sqlite on a disk: one connection writes, a transaction at a time (WAL, `BEGIN IMMEDIATE`), one reads. `logic-sdk/drizzle/pg` and `logic-sdk/drizzle/sqlite`, same names in both. No Turso, no libsql, no MySQL. Prototyped on the seam, same scenarios.
3. **One test suite for every adapter:** commit and rollback, crash, slow job, retry, fence, replace, cron dedupe, concurrent sweepers, on real Postgres. It's the conformance suite "Dispatcher contract" promises.
4. **The examples use jobs:** the shop on each host, with `databaseQueue`, and a queue on Workers. Asked for with the one-app-three-hosts demo.
5. **Live tests on deployed Workers (with Queues) and Vercel,** run by hand from Actions, as files-sdk does. Needs the owner's accounts and secrets.
6. **A function from one `init` compiles inside another's registry,** with the wrong scope. Make it a type error.
7. **Without `waitUntil`, a job isn't marked done until the jobs it queued finish.** Laravel only queues them.
8. **pg-boss: a crash on the last try never reaches `onError`.** Report it, or show why it can't be (documented today).
9. **Rolling deploys:** an old process fails a new listener's job at once. A recorded decision (DESIGN.md, "A job this code can't run"): revisit with the owner, don't change it quietly (API).
10. **Casts and `!` left in the CLI,** and the type cost of per-kind meta (about 40% more instantiations on 1,200 functions).
11. **Try it in a real app,** then release on an explicit go.

## Next

1. **Use it in a real app.** What feels clunky there decides what comes next.
2. **Durable events, then crons.** The plan is in DESIGN.md ("Next: listeners, plugins, durable events, crons").
   - **Done: the delivery contract.** One `Delivery` per (event, listener) with a dedupe id; `registry.jobs.run(delivery, { attempt })` resolves `done`/`failed` or throws to retry; `depth` on the envelope; payload and scope checked as plain JSON at emit; `ctx.event` without the stored scope.
   - **Done: `databaseQueue(db)` in `logic-sdk/drizzle`** (Postgres, Drizzle 1.0): rows in the transaction, leased first try after commit, fenced completion, Graphile-style backoff, `registry.jobs.sweep()` and `registry.jobs.retry(id)` (optional `sweep` and `retry` on the transport contract), failed rows you query yourself. The slot is `jobs` and the lists are `registry.definitions` (DESIGN.md, "Naming the slot").
   - **Done: `jobs: { adapter, scope }`,** optional `id` on every definer, scope at rest applied by the core (`store`/`load`, a `discarded` outcome), `kind` on every job.
   - **Done: `logic-sdk/cloudflare`:** `cloudflareQueue(env.JOBS)` alone or as `outbox(db, queue)`, `handleQueue(registry, batch)` for the consumer. Adapters get a `Runner` (`run`, `report`).
   - **Done: `attempts` and `delay` on listeners,** enforced by the core; adapters get `check` (refuse at startup) and `fail` (keep what a consumer failed). Tests: `begin`/`rollback` hooks, `jobs: "inline" | "manual"`, `t.jobs.drain()` and `perform()`.
   - **Done: pg-boss** (`logic-sdk/pg-boss`: `pgBoss(boss)`, `work(registry, boss)`, a queue per listener and cron). Per-key order (`key_strict_fifo`) waits for `key`.
   - **Next:** Inngest (one Inngest function per listener, from `registry.definitions`) before the adapter contract is called stable. `key`, `dedupe` and `timeout` land with those adapters, refused in `check` where they can't be honoured. Drizzle 1.0 (RC) only, like the rest of the library.
   - **Done:** the database queue's claim tested with concurrent sweepers on real Postgres (CI sets `DATABASE_URL` for every workspace).
   - **SQLite and other ORMs:** see "Before 0.5.0".
   - **Then the ladder, in order:** `pgBoss(boss)` (transactional natively), `databaseQueue(db)` (rows in the transaction, flush through `waitUntil`, sweeper), then `cloudflareQueue` and `vercelQueue`, alone (after commit, lossy, documented) or inside `outbox(...)`. Subpaths per provider. Each dispatcher declares its guarantee.
   - **Listener options:** `attempts`, `delay` (done), `key`, `dedupe`, `timeout` in code; concurrency, backoff, DLQ in infra. An option an adapter can't honour fails at startup, in its `check`.
   - **Done: crons.** `cron({ schedule, run, scope })` exported from a module, `registry.jobs.tick(at)` from a timer or any platform trigger (`handleScheduled` on Cloudflare), once per minute across servers with the outbox (`logic_cron_runs`) and pg-boss (`work()` ticks them; ids dedupe).

   Until per-listener options exist, one event per listener, and listeners with several causes recompute from current state instead of applying payloads as deltas.
3. **CLI v0.2:** `run bookings.confirm '{…}' --as agent`, rolled back by default (`--commit` to keep it); follow `run` calls inside helpers; warn on event cycles.
4. **Plugins,** no chain: plugin types declared in `Config`, values in `createRegistry({ plugins })`, typed `meta` and ctx namespaced by plugin name, runtime `{ name, wrap?, ctx?, onRegister? }` (DESIGN.md has the shape). Still to settle: composing in order, `call.parent` for nesting, what runs inside vs after the transaction, behavior in `createTestRegistry`. Then, as subpath exports, only once a real app asks for them:
   - `tracing()`: an OpenTelemetry span per function, nested like the calls
   - `audit()`: who ran which mutation, as whom, with what outcome, denied attempts included
   - `errors()`: unexpected errors to Sentry or similar, with the call chain; domain errors skipped
   - `rateLimit()`: by actor, account or function, from `meta` (IP limits stay in HTTP)
   - `usage()`: calls per account per function, for billing or plan limits
   - `idempotency()`: a replayed webhook or double click returns the first result
   - `inspect()`: dev only, a live tree of calls, opened by the CLI
5. **Ship the agent skill with the package.** Done: `skills/logic-sdk/SKILL.md` is in the tarball and the repo `AGENTS.md` is contributor-only. Next, two channels that stay in step with the installed version:
   - **TanStack Intent-compatible:** add the `tanstack-intent` keyword and `metadata.library_version` (kept current by the release), so `intent install` and `npx skills experimental_sync` find it. About 560 npm packages carry the keyword, tRPC and trigger.dev among them; Prisma ships `skills/` in its tarball the same way, without it.
   - **A managed block in the app's AGENTS.md,** written by `logic-sdk init` (or `logic-sdk agents`), Next.js style (`next dev` writes `<!-- BEGIN:nextjs-agent-rules -->`): the rules in short, plus a pointer to `node_modules/logic-sdk/skills/logic-sdk/`. `check` warns when it's stale. Vercel's evals (Jan 2026) scored an always-on AGENTS.md index at 100% against 53 to 79% for skills alone, which were never invoked in 56% of runs, so the rules stay always-on and the skill holds the depth.
6. **CLI later:** `init` (logic.ts, registry.ts, lint config, the AGENTS.md block), `add module`.

## Later

- **Scheduled calls: done.** `ctx.schedule(fn, input, { at } | { delay })` from mutations, through the jobs adapter. Later: `cancel(id)` if re-checking proves not enough, and the CLI showing who schedules whom.
- **A CLI check** that crons have a trigger in `wrangler.jsonc` or `vercel.json`, for apps with one trigger per cron. Only if missing triggers bite.
- **Test helpers** (Laravel `Mail::fake()`, Rails `travel_to`): `expectEmitted`, `tx.advance("1h")`, `tx.drain()`.
- **Opt-in savepoint `run`** for "try, and continue on failure" (e.g. coupons). `nest` already exists in the Drizzle adapter.
- **A second database adapter** (Kysely or Prisma) before 1.0.
- **Skills** in the package via TanStack Intent.
- **A module registry,** shadcn-style: `logic-sdk add auth` copies a module (tables, functions, tests) into your app, as code you own.
- **An admin panel** as a package (`@logic-sdk/admin`): a form per function from its JSON Schema, run as a chosen scope, filtered by `meta`. Built on `registry.definitions.functions` and run options.
- **Seeds:** a docs recipe, not a feature. A seed script calls real mutations through `registry.as(scope)`.
- Turbo if build caching starts to matter, tsdown only if CJS is needed, oxfmt, deploying apps/web.

Skipped: model callbacks and observers (we chose explicit), notifications, caching, broadcasting, soft deletes, a REPL console.

## Dispatcher contract

- `enqueue(tx, deliveries)` inside the transaction, `deliver(deliveries, run)` after commit, `registry.jobs.run(delivery, { attempt })` from any consumer: resolves `done` or `failed` (ack both), throws to retry.
- **Transactional queues** (pg-boss, Graphile Worker): enqueue in the same transaction. **External queues** (Cloudflare Queues, Vercel Queues, Inngest, SQS): after commit (lossy), or an outbox table plus a relay (durable).
- Tests use the in-memory dispatcher, so they're the same whatever production uses.
- Every adapter (database and dispatcher) runs a shipped conformance suite.

## Open

- **Tenancy sugar (maybe):** a typed `owned(table)` condition in `logic-sdk/drizzle`, bound to the scope, that fails to compile on tables without `accountId`. Sugar only.
- **Top-level queries** read outside a transaction, so a query with several selects can see different snapshots. A `READ ONLY` transaction flag on the adapter would fix it.
- **A typed proxy** (`caller.bookings.confirm(input)`) as sugar over `run`, after a type-cost prototype.

## Sources

- Agent skills: [TanStack Intent](https://tanstack.com/intent/latest/docs/overview), [vercel-labs/skills](https://github.com/vercel-labs/skills), [Next.js AI agents guide](https://nextjs.org/docs/app/guides/ai-agents), [AGENTS.md outperforms skills](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals), [Agent Skills spec](https://agentskills.io/specification)
- Convex: [runtimes](https://docs.convex.dev/functions/runtimes), [OCC](https://docs.convex.dev/database/advanced/occ), [actions](https://docs.convex.dev/functions/actions), [scheduling](https://docs.convex.dev/scheduling/scheduled-functions), [application errors](https://docs.convex.dev/functions/error-handling/application-errors)
- Frameworks: [Rails transactions](https://api.rubyonrails.org/classes/ActiveRecord/Transactions/ClassMethods.html), [Rails rescue_responses](https://guides.rubyonrails.org/configuring.html), [Laravel transactions](https://laravel.com/docs/database#database-transactions), [Laravel errors](https://laravel.com/docs/errors), [Ecto.Repo](https://ecto.hexdocs.pm/Ecto.Repo.html), [Oban](https://hexdocs.pm/oban/Oban.html), [Postgres isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- RPC: [tRPC metadata](https://trpc.io/docs/server/metadata), [oRPC metadata](https://orpc.dev/docs/metadata), [oRPC errors](https://orpc.dev/docs/error-handling), [AI SDK tool()](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool)
- Platforms: [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Hyperdrive with postgres.js](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/), [Vercel waitUntil](https://vercel.com/changelog/waituntil-is-now-available-for-vercel-functions)
- Jobs and events: see RESEARCH.md
- Comparables: [NestJS outbox](https://docs.nestjs.com/reliability/outbox), [DBOS](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial), [pg-boss](https://github.com/timgit/pg-boss)
- Boundaries: [Packwerk](https://github.com/Shopify/packwerk/blob/main/USAGE.md), [Elixir boundary](https://boundary.hexdocs.pm/Boundary.html), [dependency-cruiser](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)
- Tooling: [TanStack Intent](https://tanstack.com/intent/latest/docs/overview), [Stately Inspector](https://stately.ai/blog/2024-01-15-introducing-stately-inspector), [files-sdk repo](https://github.com/haydenbleasel/files-sdk)
