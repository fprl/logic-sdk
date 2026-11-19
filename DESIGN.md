# Design notes

Why each decision was made, what it was checked against, and what's still open.

## Prior art and how it shaped the API

| Source | What we took | What we didn't |
|---|---|---|
| **Convex** | `query` / `mutation` / `action`; `ctx.run…` composition inside one transaction; "modules" as the unit; helpers that take `ctx` | Its database, reactivity and codegen. Savepoint sub-transactions (see below) |
| **AI SDK** (`tool()`) | `description`, `inputSchema`, `outputSchema`, `execute(input, ctx)`; plain-object registry; Standard Schema | Per-call context schema. Our scope is app-wide, typed once in `init` |
| **Chat SDK** | Swappable pieces as adapters (`database: drizzleAdapter(db)`) | A required state adapter. The database is optional unless you have mutations |
| **oRPC v2** | The edge: typed client, OpenAPI, MCP. `toORPCRouter(registry)` | oRPC as the core. Tested: it works, but the transport ends up owning your modules |
| **Phoenix 1.8 scopes** | Explicit scope, secure by default | Passing it by hand to every function. Here it's bound once |
| **Rails `Current`** | "Set once per request" ergonomics | Implicit globals and `AsyncLocalStorage`: not portable, and hides data flow |
| **tRPC `initTRPC`** | `init<Config>()` factory for typing; named base procedures (`protectedProcedure`) became named policies | Builder chains and middleware stacks |
| **Encore** | Private by default, opt-in exposure | A compiler |
| **Vercel SDKs** | Naming: `createX` names the object returned (`createProviderRegistry` → `registry`); bare lowercase definers (`tool`, `flag`) | |

A Fable agent reviewed the first draft. Adopted from that review:

- services out of query and mutation ctx
- a listener is an action triggered by an event
- the registry with ids taken from its keys
- one `run` verb
- a nested failure dooms the transaction instead of using savepoints
- the envelope and dispatcher seam
- `authorize` as both permission check and visibility (later replaced by `expose`)
- `reject`/`deny`/`notFound` instead of error maps
- `inputSchema`/`execute` naming, the `init` factory, scope changes per call (was `ctx.with` until 0.3.0), and a single `wrap` hook

Not adopted: `await using` in tests. It isn't safely portable across runtimes yet, so tests use a callback instead.

## Decisions

- **One `run` verb**, typed per ctx: a query can run queries; a mutation, queries and mutations; an action, anything. There's a runtime guard behind the types.
- **Doomed transactions, not savepoints.** Savepoints cost a round trip per call and aren't available on every driver. With dooming, a caught nested failure can't commit partial writes. Savepoints are still used in the test helper, where they're what you want.
- **No `services` in mutations.** It's the rule that makes "a mutation is just data in one transaction" true, and it's what removes mocks from tests. It's the strictest call in the design; see open questions.
- **`expose` with named policies** (replaced "`authorize` = exposure", which read as magic). Missing means internal, so forgetting it is safe. A policy written as a type guard narrows `scope` in `execute`, and it runs on every call, nested ones too, so the narrowing never lies. Exposure is tracked at the type level (`Fn<…, true>`), so adapters' types only include exposed functions.
- **One door.** Your own server code is trusted, like a Convex `httpAction` calling `internal.*` or a Rails job calling a model. "Internal" means no adapter publishes it. There's no "system" concept: scope is the app's type.
- **The registry is required** (`createRegistry({ modules })`). Ids feed errors, events, tracing, adapters and stubs. Auto-discovery means a new listener can't be forgotten.
- **`init<Config>()` returns typed constructors and a typed `createRegistry`.** In 0.1 it was curried to infer policy names; 0.2 passes policies by reference, so the second call went away.
- **Function references are plain imports**, and types flow one way. `run(fn, input)` is the one call shape: definitions exist from startup and the caller per request, so route helpers, stubs and adapters take definitions. A typed proxy (`caller.bookings.confirm()`) may come later as sugar.
- **`on(() => event, …)` is lazy**, resolved at `createRegistry`, so listeners import other modules' barrels without import-cycle crashes.
- **Validate and check before the transaction**, so bad or denied calls never take a connection. Transaction state is created per attempt, so a retrying adapter can't reuse events from a failed one.
- **The scope is JSON.** It travels with events, so a durable dispatcher can store it.
- **Errors live on `ctx`** (`reject`, `conflict`, `notFound`, `deny`), namespaced to the caller's module, so a module only mints its own codes. Six fixed kinds, no HTTP in core; adapters map kinds to statuses, like Rails' `rescue_responses`. Codes stay untyped: under composition a typed per-function list would have to repeat every nested code (oRPC types them per procedure; tRPC and Convex don't). Authentication is the edge's job (`unauthenticated()` in `resolveScope`).
- **`outputSchema` is required on exposed functions.** What leaves the process is a contract, it strips internal columns, and oRPC, OpenAPI and AI tools reuse it.
- **Lost races are retried** (40001/40P01, 3 attempts, short random pause), like Laravel's `DB::transaction(fn, attempts)` and Convex's automatic OCC retries. The adapter decides what's retryable; the registry loops. Safe because mutations have no side effects and transaction state is per attempt.
- **`toAITools(registry, caller)`** mirrors the oRPC adapter: exposed functions only, named `module_function`, every call through `caller.run`. Domain errors reach the model with their details so it can recover; anything unexpected becomes `internal_error`, so internals never enter the model's context. `DomainError`'s message now includes its details for the same reason (the AI SDK shows the model only the message).
- **The CLI reads, it doesn't run.** `@logic-sdk/cli` loads the modules with jiti and asks the app's own `logic-sdk` (`describeModules`, no database) what's registered; `run`/`emit` edges and imports come from parsing the source with oxc. TypeScript 7 has no stable JS compiler API, and knip uses the same stack. Commands are Stricli; output is plain `node:util` `styleText` (no TUI library: the output is printed, piped and read in CI). Patterns from Laravel `route:list`/`model:show`, Phoenix `mix xref graph`, Packwerk `check` and Vercel's agent mode (`--json`, exit codes 0/1/2).
- **Node 24 and 26.** The repo develops on 26; the packages declare `>=24` because nothing in them needs 26, and Node 24 is supported until April 2028.
- **`maxEventDepth` defaults to 8.** Real chains are 2 or 3 hops; deeper is almost always a loop.

## Code review fixes

A second Fable pass reviewed the built code and found real bugs. All are fixed, each with a regression test:

- an invalid event payload followed by a throw caused an unhandled rejection that crashed Node
- post-commit errors (an unbound `waitUntil`, a throwing `onError`, a throwing dispatcher) reached the caller as if the mutation had failed
- `emit` was typed with the schema's output instead of its input
- `throw undefined`, or a nested invalid input that the caller caught, didn't doom the transaction
- invalid output or payloads were sent to clients as 400s with schema details; they're now 500s
- `dispatch` swallowed listener failures, which defeated retries
- type holes: missing services or database accepted, possibly-undefined exposure, untyped stubs
- no guard against listener loops
- `wrap` didn't see denied or invalid calls
- the fetch adapter accepted non-JSON POSTs (CSRF), sent no `Allow` header on 405s, and required a trailing slash on `basePath`

## Verified

- 41 core tests on Bun (`bun test`), plus compile-only type tests where every `@ts-expect-error` must fire.
- `examples/node`: 15 tests with Vitest on Node 26, run both on PGlite and on Postgres 17 in Docker (`test:pg`; CI uses a Postgres service). Running on real Postgres caught tests that assumed an empty table. The Hono server was run against Postgres 17 in Docker.
- `publint --strict` and `attw --profile esm-only` pass on the packed tarball.
- `toAITools`: 6 tests through the real AI SDK (`generateText` with `MockLanguageModelV4`), checking what the model actually receives. `examples/nextjs` built with `next build`; its Server Action path was run in the browser against Postgres. The agent path wasn't run against a real model (no API key available).
- **The double-booking race, on real Postgres** (`bun run test:pg`, 10 rounds of 3 concurrent confirms, run 10 times: 100/100 rounds clean). An earlier version of this file claimed the race was verified on PGlite. It wasn't: PGlite runs one transaction at a time, so nothing raced. On real Postgres the losers got raw `23P01` and `40P01` errors (500s). Retries alone didn't fix it: overlapping inserts deadlock inside the exclusion constraint, Postgres only detects that after `deadlock_timeout` (1s), and retries collide again meanwhile. The fix is the standard one for bookings: `availability.hold` takes a per-property advisory lock before checking, so confirms queue up and losers get a clean `conflict`.
- `examples/workers`: tests inside workerd with `@cloudflare/vitest-plugin` (the replacement for the deprecated `vitest-pool-workers`), Hyperdrive pointed at an in-process PGlite socket server, listeners finishing in `ctx.waitUntil`. `wrangler dev` was run against Postgres 17 in Docker.
- Drizzle 1.0 RC: casing moved from `drizzle({ casing })` to the tables (`snakeCase.table`), and `PgDatabase` became `PgAsyncDatabase`. The adapter needed no change.
- Cloudflare D1 rejects `BEGIN`/`SAVEPOINT`, hence "no D1 for mutations".
- The oxlint boundary rule catches cross-module imports. typescript-eslint doesn't support TypeScript 7 yet.

## Open questions

1. **Pure services in mutations.** A mutation that needs a pure dependency (a pricing table, an id generator) currently has to use `db`, `now`, or a plain import. Should there be a `deps` slot for side-effect-free things, or is that the slope back to mocks?
2. **A durable dispatcher.** The seam is there: a Postgres outbox (`enqueue` inserts rows in the same transaction; a worker calls `registry.dispatch`) is about 60 lines. Workflow DevKit or Cloudflare Queues would be adapters on top.
3. **A Postgres `READ ONLY` transaction for queries**, as an adapter flag. Today it's a type-level guard only.
4. **An MCP and AI SDK tools adapter** (`toAITools(registry)`): each exposed function is already `description` + `inputSchema` + `execute`. oRPC's MCP package covers it via `toORPCRouter` in the meantime.
5. **The name.** `logic-sdk` ("Logic SDK") was free on npm and GitHub on 2026-11-19. `bounded` was taken by an unrelated agent-guardrails tool with its own `bounded` command. Whether the `@logic-sdk` scope is free couldn't be checked without logging in.

## 0.2.0: authorization, settled

Reviewed against Laravel's current docs, 37signals' Fizzy source, Next.js, Convex, Phoenix and the RPC libraries, then stress-tested in several independent reviews.

- **`authorize` and `expose` are two keys.** Every reference stack separates "reachable" (`"use server"`, Convex `query` vs `internalQuery`, TanStack `createServerFn`) from "who" (checks in the body, middleware). `expose: true` without `authorize` is a type error, so you still can't publish something without deciding who.
- **Policies are sync type guards over scope, passed by reference.** Sync because TS can't narrow through a Promise and because they run before validation and before any database work. Return-style narrowing (tRPC's `next({ ctx })`) works too, but needs runtime identity checks to be safe; not worth a new concept for the handful of policies an app has.
- **Policy before validation, and exactly `true`.** Anonymous callers never see a protected function's schema errors (Laravel authorizes first); a truthy non-boolean or a Promise fails closed.
- **Record rules stay in `execute`, the Fizzy way.** Load through a scoped helper (404 for what you can't see), then a sync `can*` predicate (403), reused for UI flags in lists. Rejected: an async policy that loads the record (`ctx.auth`): it reads before the transaction, retries reuse the stale row, and lists need the predicate anyway. Rejected: `ctx.authorize(fn, record)`: a second way to call the same predicate. The CLI keeps the pattern safe instead: `async-can` (an async `can*` would fail open when negated) and `unused-can`.
- **No `anyone` export, no `ctx.can`, no policy cache.** One line in your app, a later non-breaking addition, and over-engineering, in that order.
- **Errors moved to `ctx.errors`.** Destructured `reject` read like a Promise executor's. `throw` stays: a never-returning `ctx.errors.notFound()` wouldn't narrow, because `ctx` is contextually typed (tested on tsc 7.0.2).
- **The agent door is opt-in.** `toAITools` requires a `filter`; `toAITool(caller, fn)` is the per-function form, like the AI SDK's own `tool()`. Approval stays the AI SDK's `toolApproval`.

## 0.3.0: config and run options

- **`ctx.config`** holds the settings your rules read (base URL, limits, switches), declared in `init<Config>()` and passed once to `createRegistry({ config })`. Plain data, copied and frozen; tests override parts of it. Why: 7 of 7 real apps we read (Fizzy, Campfire, Mastodon, Plausible, Firefly III, Documenso, Dub) read a few settings inside domain code, and their tests change them by mutating globals. Laravel's rule (`env()` only in config files, `config()` everywhere) made structural. Not scope (it's cloned into every event) and not services (queries and mutations can't see them).
- **Env stays outside modules.** Read it however you like at the entry, in routes and scripts. `logic-sdk check` fails on env reads inside modules, directly or through app files they import (type-only imports don't count). A module importing the platform env (`cloudflare:workers`) can't even load outside the platform, so the CLI couldn't inspect it.
- **Per-call options: `run(fn, input, { scope, signal })`.** `registry.as(scope)` only says who; `with` is gone. Why: one place for "this call is different", and the adapters can pass on the signal their handler gets (oRPC's `signal`, the AI SDK's `abortSignal`), which they couldn't with a caller already bound. Acting as someone else is visible to the CLI on every call (`runs tasks.assign (scope: actor)`), which a stored `ctx.with(...)` wasn't.
- **A signal is checked only before the call it's passed to starts**, never between your steps, so a caller who disconnects can't leave a workflow half done. Actions get it as `ctx.signal` to pass on to `fetch` or an AI call. Rails, Laravel and Convex don't cancel on disconnect either.

