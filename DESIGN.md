# Design notes

Why each decision was made, what it was checked against, and what's still open.

## Prior art and how it shaped the API

| Source | What we took | What we didn't |
|---|---|---|
| **Convex** | `query` / `mutation` / `action`; `ctx.run…` composition inside one transaction; "modules" as the unit; helpers that take `ctx`; `handler(ctx, args)` with ctx first | Its database, reactivity and codegen. Savepoint sub-transactions (see below) |
| **AI SDK** (`tool()`) | `description`; plain-object registry; Standard Schema. Until 0.4.0 also `inputSchema`/`outputSchema`/`execute(input, ctx)` (see 0.4.0) | Per-call context schema. Our scope is app-wide, typed once in `init` |
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
- `inputSchema`/`execute` naming (replaced in 0.4.0), the `init` factory, scope changes per call (was `ctx.with` until 0.3.0), and a single `wrap` hook

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

- **`db` is one type with two sides: `db: DrizzleDb<Db>`.** It was `db` plus an optional `reader` that defaulted to `db`, so leaving one line out let queries write. `ReadWrite<Reader, Tx>` is the plain shape for other ORMs. What would change it: queries that need a different database altogether (a replica), which is a value, not only a type.

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
- `examples/bookings` (was `examples/node`): 15 tests with Vitest on Node 26, run both on PGlite and on Postgres 17 in Docker (`test:pg`; CI uses a Postgres service). Running on real Postgres caught tests that assumed an empty table. The Hono server was run against Postgres 17 in Docker.
- `publint --strict` and `attw --profile esm-only` pass on the packed tarball.
- `toAITools`: 6 tests through the real AI SDK (`generateText` with `MockLanguageModelV4`), checking what the model actually receives. The former `examples/nextjs` built with `next build`; its Server Action path was run in the browser against Postgres. The shop's Next.js host was run the same way. The agent path wasn't run against a real model (no API key available).
- **The double-booking race, on real Postgres** (`bun run test:pg`, 10 rounds of 3 concurrent confirms, run 10 times: 100/100 rounds clean). An earlier version of this file claimed the race was verified on PGlite. It wasn't: PGlite runs one transaction at a time, so nothing raced. On real Postgres the losers got raw `23P01` and `40P01` errors (500s). Retries alone didn't fix it: overlapping inserts deadlock inside the exclusion constraint, Postgres only detects that after `deadlock_timeout` (1s), and retries collide again meanwhile. The fix is the standard one for bookings: `availability.hold` takes a per-property advisory lock before checking, so confirms queue up and losers get a clean `conflict`.
- The former `examples/workers`, now the shop's Worker tests: tests inside workerd with `@cloudflare/vitest-plugin` (the replacement for the deprecated `vitest-pool-workers`), Hyperdrive pointed at an in-process PGlite socket server, listeners finishing in `ctx.waitUntil`. `wrangler dev` was run against Postgres 17 in Docker.
- Drizzle 1.0 RC: casing moved from `drizzle({ casing })` to the tables (`snakeCase.table`), and `PgDatabase` became `PgAsyncDatabase`. The adapter needed no change.
- Cloudflare D1 rejects `BEGIN`/`SAVEPOINT`, hence "no D1 for mutations".
- The oxlint boundary rule catches cross-module imports. typescript-eslint doesn't support TypeScript 7 yet.

## Open questions

1. **Pure services in mutations.** A mutation that needs a pure dependency (a pricing table, an id generator) currently has to use `db`, `now`, or a plain import. Should there be a `deps` slot for side-effect-free things, or is that the slope back to mocks?
2. **A durable dispatcher.** Settled as a ladder of dispatchers (`inProcess`, after-commit queues, `outbox()`, `outbox(queue)`, `pgBoss`); see "Next: listeners, plugins, durable events, crons".
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


## 0.4.0: input, output, handler(ctx, input)

- **Names from app-logic libraries, not AI tools.** Counted in each library's current docs (2026-11-20). AI-tool definers say `inputSchema`/`execute`: the AI SDK, Mastra and MCP use `inputSchema`; the AI SDK, Mastra and the OpenAI Agents SDK use `execute`. App-logic definers say `handler`: Convex, oRPC, TanStack Start and Inngest do, and none of the seven says `execute`. For the schemas, tRPC and oRPC say `input`/`output`. We took `inputSchema`/`execute` from the AI SDK in 0.1, when agents were the headline; they're one adapter, and `toAITool` maps the fields either way.
- **`ctx` first, like Convex.** There's no consensus on order: five libraries pass one object, five put the input first (mostly AI and task tools), and Convex puts ctx first. `ctx` is the argument every handler uses, so it goes first. A function without input is `handler(ctx)`, not `execute(_, ctx)`, and handlers, listeners and helpers (`findOrder(ctx, id)`) follow one rule. A third argument is never needed, because per-call data lives on ctx (`ctx.signal`, `ctx.event`). We passed on a single object (`handler({ ctx, input })`) because it would add a destructure to every body and break the helpers-take-ctx idiom.
- **`input` instead of Convex's `args`.** "Input" is already the word in `run(fn, input)`, the docs and `invalid_input`. Convex's `args` is a record of validators, so agents would write `args: { … }` and get it wrong with Zod.
- **No input: leave it out.** The handler gets only `ctx`, and callers write `run(fn)`, which replaced `run(fn, undefined)`. Whatever an adapter sends is ignored: AI tools always send `{}`, so `toAITool` publishes an empty object schema for these. Exposed functions with input still validate it. For an internal function you trust, a pass-through schema skips the checks.
- **`init` stays.** It only binds types: modules import the definers and the registry imports the modules, so runtime pieces (database, services, config) can't move into it without an import cycle and env reads inside modules. That rules out a betterAuth-style `logic({...})`, which takes runtime config. `createLogic` would read as "create the logic", but the logic is your modules. `init` is honest set-up, as in tRPC's `initTRPC`.
- **Ctx types come from `Config`.** `type QueryCtx = QueryCtx<Config>` in your logic file, like Convex's generated `QueryCtx`. The scope defaults to `Config`'s. A helper that needs the narrowed scope says so where it's used: `QueryCtx & { scope: SignedIn }`. Rejected: deriving it from the definer (`CtxOf<typeof query>`), the right move when a value is the source of truth (`z.infer`, Drizzle's `$inferSelect`), but here `Config` already is. Rejected: TanStack-style `declare module` registration, a global for two saved lines.
- **Events declare `payload`**, the one shape they have, so they name the thing like functions do.
- **One event per listener.** Typed precedents either group per-event handlers in one class (Laravel and Symfony subscribers, Commanded) or take an array of events with a union payload you narrow on the event name (Inngest). Two `on`s calling one helper keep exact payload types and show both edges in `graph`. Listening to everything is `wrap`'s job, or a plugin's later.
- **No `emits: [...]` declaration.** The CLI already reads `emit(...)` calls (`show` prints them, `event-never-emitted` checks the other side). A declared list would only earn its keep as a contract across a boundary, such as a durable queue shared with another service.

## Next: listeners, plugins, durable events, crons

Settled on 2026-11-20 after reading Rails, Fizzy, Laravel, Phoenix, Oban and the JS platforms (RESEARCH.md has the evidence) and an independent Fable review. Only the listener shape ships in this change; the rest is the plan.

### `listener({...})` replaces `on(...)`

```ts
/** Email the receipt */
export const sendReceipt = listener({
  event: () => placed,
  async handler(ctx, payload) { ... },
});
```

- **Options came after the handler** (`on(ev, handler, { description })`), and durable delivery brings more of them (retries, key, delay). Every other definer takes one object; listeners now do too.
- **Listeners were invisible to plugins.** `wrap` got no `meta` for them, so tracing, audit or rate limits couldn't see them. With an object they take `meta` like functions.
- **Nouns, like the other definers:** `query`, `mutation`, `action`, `event`, `listener`, in a file called `listeners.ts`. The field is `event`, matching the `event()` it points at. Fable preferred keeping the name `on`; we chose consistency.
- **The CLI reads object keys,** which is simpler and sturdier than positional arguments.
- **The thunk stays.** Listeners run at module evaluation and module barrels import each other; accepting both `placed` and `() => placed` would be two ways to do one thing. What would change it: a typed string id (`event: "orders.placed"`) checked against the registry type, which costs the one-way type flow.
- **Options are flat,** like `authorize` and `expose`, not under `config: {}` (which already means `ctx.config`). They arrive with durable delivery (below).

### No `description` field: JSDoc for people, adapter meta for tools

- **Nobody has one in the definition.** Convex `query`, tRPC, TanStack Start `createServerFn` and Inngest `createFunction` don't; the AI SDK's `tool()` description is optional; trpc-to-openapi reads `meta.openapi.description` and oRPC `.meta(openapi({ description }))`. Text for a tool lives in that tool's namespace of meta.
- **People get JSDoc.** One sentence above each export shows on hover wherever the function is used, which a field never did, and the CLI reads it statically (oxc returns comments with positions; about 10 lines), first paragraph only.
- **Each adapter's type says where it's read: `ForFunctions`, `ForListeners`.** `meta: AppMeta & AIMeta & PgBossMeta` reads the same, and `pgBoss` on an action is now an error where it was silently ignored. Considered: TypeScript augmentation, which is project-wide, so a second `init` would offer options its registry doesn't have; a `listenerMeta` key in `Config`, which grows one key per kind (the user: "the lib becomes sufferable"). tRPC's `meta<M>()` is per instance too ([metadata](https://trpc.io/docs/server/metadata)). What would change it: an adapter that reads one option on only some kinds of function.
- **Adapters own a namespace in your meta and export its type.** `logic-sdk/ai` exports `AIMeta = { ai?: { tool?, description? } }`; you add it to your shape (`meta: AIMeta & AppMeta`). Meta stays yours: the library reserves no key, so nothing collides with your own `description`.
- **Options last override meta,** for every adapter: `toAITool(caller, fn, { description })`, or `describe: (f) => …` on `toAITools` (the bulk form), then `meta.ai.description`, else none. `toAITools` defaults `filter` to `meta.ai.tool === true`, so the agent door stays opt-in without a key of your own.
- **Cost, accepted:** nothing flags a tool without a description (models pick worse; a `check` rule could warn later).
- **Only security rules get a runtime check.** The types reject a missing handler, a non-function policy or an async one; repeating those at runtime only reworded errors TypeScript already gives (an async policy is denied anyway, since a policy must return exactly `true`). What stays is `expose` without `authorize` or `output`, checked in `createRegistry` so it names the function ("orders.cancel has expose: true but no authorize"): an exposed function nobody authorizes is a hole for JS callers and casts, not just a type error. Config and event payloads share one plain-data check.
- **What would change it:** several library-owned descriptive keys arriving (`title`, `tags`, `deprecated`), where a typed base would scale better than namespaces.

### No per-function middleware

tRPC, oRPC and TanStack Start chain `.use(mw)` because they are the HTTP edge: middleware resolves the session or organization and adds it to ctx. Here that work happens once, at the entry, into `scope`, the way Phoenix 1.8 builds `%Scope{}` in a plug and passes it first to every context function. What's left per function is covered without a chain:

- **who may call it:** `authorize`, a type guard that narrows `ctx.scope`
- **load what it needs:** a helper, `findProject(ctx, id)`, inside the transaction (Rails' `before_action :set_project`, but retried and account-scoped)
- **cross-cutting:** `wrap` with typed `meta`, and plugins (below)

What would change it: a real app needing ctx types that depend on per-function middleware order. Neither we nor Fable could construct one a helper doesn't cover.

**Type-check cost, measured.** A generated app of N modules, each with 2 queries, 2 mutations (calling `ctx.run` across modules and `emit`), an event and a listener, plus a registry and one `caller.run` per function. The baseline is the same zod schemas as plain async functions, without authorize narrowing, output checks, events or a registry, so it's a floor, not an equal. Check time, best of 2 or 3 runs:

| Modules (functions) | Plain, TS 7 / 5.9 | Five overloads (0.4.0), TS 7 / 5.9 | One signature, TS 7 / 5.9 |
|---|---|---|---|
| 150 (600) | 0.09s / 0.58s | 0.40s / 1.56s | 0.36s / 1.37s |
| 300 (1,200) | 0.30s / 1.07s | 0.88s / 2.52s | 0.75s / 2.64s |

- **Linear,** about 2.5x to 4x the floor: about 0.4ms per function over it on TS 7. The real shop checks in 0.32s on TS 7, most of it Next.js.
- **One signature replaced the five `Constructor` overloads.** Same speed (within 10%), much clearer mistakes: `expose: true` without `output` now says "Property 'output' is missing" instead of "No overload matches this call", and a wrong return type points at the handler. The trace showed overloads re-checking a definition per failed candidate, but that wasn't where the time went.
- **A 10x trap:** typing the exposed `output` as `OS & Schema` made TypeScript compare each zod type structurally against Standard Schema on every definition (0.40s became 4.4s at 600 functions). The field stays `output: OS`, with a comment.
- **Variance annotations** (`out` on `Fn` and `EventDef`, the trick TanStack Start uses with `in out`): no measurable change (874,099 vs 874,579 instantiations), so not adopted.
- **`any` compared with the chain libraries:** 10 in our 832-line core; tRPC 40 in 792 (`procedureBuilder.ts`); oRPC 16 in 327 (`builder.ts`) and 29 in 105 (`router.ts`); Convex 89 in 772; TanStack Start about 35 in 934 (`createServerFn.ts`). Chains erase at every step because each step changes the builder's type.

### Plugins without a chain

Plugin contributions are app-wide and known at `init`, so the object model carries them:

```ts
type Config = { scope: Scope; db: DrizzleDb<Db>; services: Services; plugins: [Audit, RateLimit] };   // types only
export const { query, mutation, listener, createRegistry } = init<Config>();

mutation({
  meta: { rateLimit: { max: 10 } },          // typed by the plugin, under its name
  async handler(ctx, input) {
    await ctx.audit.log("refund", { orderId: input.orderId });   // ctx added by the plugin, under its name
  },
});

createRegistry({ modules, plugins: [audit(), rateLimit({ store })] });  // a value for each declared plugin, like services
```

- **Namespaced by plugin name** on both sides (`meta.rateLimit`, `ctx.audit`): no collisions, and it greps.
- **Types:** `FunctionMetaOf<C>` and `ListenerMetaOf<C>` add `{ [P in Plugins as P["name"]]?: P["meta"] }`, and the ctx per kind adds `{ [P in Plugins as P["name"]]: P["ctx"][K] }`, so a plugin can add to mutations only.
- **Runtime:** `{ name, wrap?, ctx?: { query?, mutation?, action? }, onRegister? }`. `wrap` is the existing hook; `onRegister` sees every definition, for checks like "every exposed mutation has a rate limit".
- **Jobs are core, not a plugin.** Scheduling needs the transaction handle, which is the dispatcher's seam.
- **What would change it:** a plugin whose ctx type depends on per-function order. Same test as middleware above.

### Durable events: a ladder, composed by wrapping

Configured once, where the registry is created:

```ts
jobs: { adapter: inProcess() }                                  // default: zero infra, lost on a crash
jobs: { adapter: cloudflareQueue(env.JOBS) }                    // sent after commit: the Rails/Laravel model, lossy
jobs: { adapter: outbox(db) }                                   // durable, Postgres only
jobs: { adapter: outbox(db, { via: cloudflareQueue(env.JOBS) }) } // durable handoff, plus queue retries, DLQ, concurrency
jobs: { adapter: pgBoss(boss) }                                 // transactional natively, no outbox needed
```

- **Ship the lossy mode.** It's the Rails 8.2 and Laravel `after_commit` model, and fine for consequences you can lose (a live update, a cache warm-up). Fizzy uses it on purpose.
- **`outbox()` is the durable path:** it inserts rows in the mutation's transaction, flushes them after commit through `waitUntil` (which the registry already takes), and a sweeper retries what a crash left behind. It's Fizzy's "state row plus recurring sweep", without writing it by hand. It needs only Postgres, which every app with mutations has, so it behaves the same on Node, Workers and Vercel; a queue on top adds isolation, concurrency and a DLQ.
- **pg-boss needs no outbox:** `send(..., { db })` joins the transaction, like Oban or Laravel's database driver.
- **Every dispatcher declares its guarantee** (`at-most-once` or `at-least-once`), and `logic-sdk check` prints it, so the choice is visible.
- **Adapters per provider, as subpaths** with optional peer dependencies: `logic-sdk/pg-boss`, `logic-sdk/outbox`, `logic-sdk/cloudflare`, `logic-sdk/vercel`. Runtime is the host entry's job, and each provider's adapter covers both events and crons. Inngest and Upstash ship the same way: one core, a thin adapter per target.
- **Cost:** the first table the library owns, and the sweeper needs crons.

### Crons: a definer, discovered like listeners

```ts
// orders/crons.ts
/** Expire carts nobody touched for a day */
export const expireCarts = cron({
  schedule: "*/15 * * * *",
  run: expireStale,          // a function, run with its policy, validation and tracing
  scope: system,             // required: a cron has no caller, so it says who it runs as
});
```

- **One unit per export,** exported through the module's `index.ts` and found by `createRegistry({ modules })` like listeners, so a new cron can't be forgotten. No central file and no `define` prefix: it reads like `query`, `event` and `listener`.
- **`run` is an existing function, `scope` is required.** Convex (`crons.cron(name, expr, internal.fn, args)`), Laravel's `Schedule::job`, Solid Queue's `class` + `args` and Oban's worker all point at an existing unit, so it keeps its policy, validation and tracing and is tested on its own. `input` is typed by the function and checked as JSON at `createRegistry`. Convex doesn't pass auth to scheduled functions either; a required scope says who acts.
- **One entry point, `registry.jobs.tick(at)`:** it runs every cron due in `at`'s minute, as a job with the id `<cron id>@<minute>` through the `jobs` adapter. The platform only says when to tick, so one trigger per cron and one `* * * * *` trigger both work: Node uses a timer, Cloudflare `handleScheduled(registry, controller)`, Vercel a Schedules route (Cron Jobs are legacy there, verified), pg-boss the tick in `work()` (see "pg-boss (step 4)"). Laravel's official setup is the every-minute one (`* * * * * php artisan schedule:run`). The first sketch here mapped `controller.cron` to crons and had a route per cron on Vercel; that ties correctness to strings matching "character-for-character" (Cloudflare's docs) and to config drift.
- **Once per minute across servers, with the outbox:** `logic_cron_runs`, one row per `<cron id>@<minute>`, written in the tick's transaction `on conflict do nothing`, pruned after a day. Solid Queue's recurring executions (unique on task key and run time) do the same; Laravel's `onOneServer()` takes a cache lock per task and minute; Oban elects a leader. The outbox's own rows can't do it: they're deleted once done. `inProcess()` runs a tick wherever it's ticked, like Laravel without `onOneServer()`.
- **Five fields, our own matcher, croner as the test oracle.** It only answers "is this minute due in this time zone", about 80 lines on `Intl`, so the core keeps one dependency. Tests compare it with croner minute by minute over a week, a month end and a leap day. No seconds (Oban: "one-minute resolution at minimum"; Cloudflare and Vercel are minute-only), no `@daily` aliases (one way to write it), no `L`/`W`/`#`, and `5/15` is refused: crons disagree on it, and croner refuses it too.
- **Weekday numbers differ by platform:** Cloudflare's triggers use 1 = Sunday ("which is different on some other cron systems", its docs), classic cron and Vercel 1 = Monday. We follow classic cron, and the docs say to write weekdays as names when a platform trigger repeats a cron's string. Fable caught this in review: a copied `0 9 * * 1` fires on Sunday on Cloudflare, and the Monday cron never runs.
- **Time zones on the wall clock, Laravel's DST semantics:** a time skipped when clocks go forward doesn't run, one that happens twice runs twice. Croner shifts skipped runs instead; we follow Laravel, which documents it and suggests avoiding time zones.
- **Missed minutes are skipped and runs may overlap:** pg-boss's `missed: 'skip'` default, and Laravel, Oban and Vercel all allow overlap by default.
- **Tests run crons inline:** `t.jobs.tick(at)` runs what's due at that minute and throws a failure, in both modes, so `t.jobs.queued` stays listener jobs.
- **`ctx.schedule(fn, input, { at } | { delay })`: a third job kind, mutations only, no cancel.** Checked with Fable against the stacks. Convex's `runAfter`/`runAt` return an id and are atomic from mutations (not from actions); we schedule only from mutations, so a rollback never leaves a call behind, and actions run a mutation that schedules. Seconds, like a listener's `delay`; `at` is a `Date`. No cancel in v1: Convex and Oban have one, Rails and Laravel don't, and Convex notes a call that "already started" keeps running, so the function re-checks its reason either way; the returned id keeps `cancel` addable. It runs as the mutation's scope through `jobs.scope`, one try.
- **`replace: key`, so a schedule that changes doesn't run twice** (an outside reviewer's catch: move a booking's dates and both reminders find a valid booking and send). The stacks (Fable, from source): Oban's `unique` with `replace: [scheduled: [:scheduled_at]]`, Laravel 13's `DebounceFor` (the latest wins; [queues.md, "Debounced Jobs"](https://github.com/laravel/docs/blob/13.x/queues.md#debounced-jobs)), pg-boss's upsert by `singletonKey` (edits a `created` or `retry` job), Convex only `cancel(id)`, Solid Queue only discards the newcomer. We take latest-wins, scoped to `(fn, key)`, and only for a call not started yet. The job keeps a random id plus a `replace` field rather than a fixed `<fn>@<key>` id: pg-boss skips an insert while any row with that id exists, finished ones included (kept 7 days), so a fixed id would drop the reschedule silently. The outbox keeps one waiting row per key with a partial unique index (`status = 'pending' and attempts = 0`) and upserts into it, so two transactions replacing at once can't both insert. Adapters opt in with `replaces: true`; `cloudflareQueue` alone can't take back a sent message, so it's refused, like a delay it can't hold. Named `replace`, Oban's word, so `key` stays free for per-key ordering (Solid Queue's and GoodJob's meaning). The listener's planned `dedupe` is first-wins, a third thing.
- **Adapters say whether they can hold a job (`holds: true | { max }`),** and the core refuses a delayed listener or `ctx.schedule` on one that can't. Laravel's sync queue drops the delay (`SyncQueue::later` just pushes) and Rails' `:async` adapter "drops pending jobs on restart": both would run a "tomorrow" reminder now or lose it. This replaced Cloudflare's own delay check (`holds: { max: 86400 }`), and `inProcess()` now refuses delayed listeners, which it used to run at once. Tests hold what waits until `drain()`, which runs what's due at the test's `now` or `until` (Rails' `perform_enqueued_jobs(at:)`, Oban's `with_scheduled`), each job at the time it was due, so a job that reschedules itself moves forward instead of looping (Fable's catch). The test registry holds what the app's adapter holds, so a missing outbox fails in tests, not first in production.
- **The core is split by what changes together,** after crons made jobs its second big part: `types.ts` (public types), `jobs.ts` (`makeJobs`: deliveries, cron runs, `registry.jobs`), `errors.ts`, `schedule.ts`, and `index.ts` for `init`, `createRegistry`, calls, transactions and ctx. Calls, transactions and ctx stay together because they share the frame and transaction state; splitting them is where 20-parameter functions come from (Fable). `jobs.ts` gets what it needs from the registry in one object, including `runAs` and `listenerCtx`, so it never sees a frame. No public change: `index.ts` re-exports the same names.
- **Crons run as a system scope, a variant of the app's own type, not a fake user.** The first shop example ran its digest as `{ user: { id: "system", role: "staff" } }`; the user flagged it. Phoenix's scopes guide keeps the scope your own struct, `user: nil`, with fields for scopes "not tied to a user"; Convex passes no auth to scheduled functions. So the pattern is userland: `System = { actor/user: null; system: name }`, and policies grant it explicitly (`staffOrSystem`), while `signedIn` and `staff` keep saying no. Not a core API: the library defines no scope fields.
- **`startTicking(registry)` in `logic-sdk/node`, not a snippet.** Laravel ships `schedule:work` and Solid Queue a scheduler process: the framework owns the loop, not the app. Our first docs snippet awaited `tick` then `sweep` before arming the next timer, so a slow sweep (or, with `inProcess()`, a slow cron) skipped minutes silently (an outside reviewer's catch; Fable widened it). The helper arms the next minute before ticking and sweeps on its own loop. A late timer ticks the current minute, not a backlog: a laptop waking from sleep would otherwise replay hours of crons. A subpath because it's meaningless on Workers, and the core stays runtime-neutral. Sweeps overlap like ticks since 2026-11-22, with the same cap of ten: one at a time, a job that never returned stopped every sweep until a restart. A queue's answer is the same (one hung worker doesn't stop the others).
- **`stop({ timeout })` resolves once the running ticks and sweep finish, or after `timeout` (30 s),** for a graceful shutdown that can't hang during the outage it shuts down in, like pg-boss's `stop()` (graceful, `timeout` 30 s by default) and Laravel's worker finishing its job on SIGTERM. A throwing `onError` is caught, as the registry does, so it can't kill the sweep loop.
- **At most ten ticks in flight, then a minute is skipped and reported.** Laravel's `schedule:work` starts `schedule:run` every minute regardless and Oban documents overlapping runs, so overlap stays. But their tick only spawns or inserts; ours runs the crons (with `inProcess()`) or waits on the database, so an outage stacked a tick per minute, each waiting for a connection, and when it came back a backlog of stale minutes ran: the catch-up we refuse elsewhere. Ten covers crons that run long; more means they're stuck, or ten slow crons overlap (also reported). An outside reviewer's catch, shaped by Fable.
- **Not now:** helpers (`daily()`), seconds, `withoutOverlapping`, catch-up, schedules created at runtime, and a check that reads `wrangler.jsonc` or `vercel.json` for missing triggers.

### Options: correctness in code, tuning in infra

**The rule:** if an option changes whether the result is correct, it belongs on the listener, in code, chosen by you. If it changes capacity or operations, it belongs to the transport or the platform config. Laravel draws the same line: a job's `$tries` beats the worker's `--tries`, while Cloudflare and Oban put concurrency in queue config.

| On the listener | Meaning |
|---|---|
| `attempts` | tries in total, the first included (default 1) |
| `delay` | run it N seconds after the event |
| `key` | same key runs one at a time, in order (per conversation, per account) |
| `dedupe` | never run twice for the same event; defaults to event id plus listener id |
| `timeout` | give up after N seconds |

Transport side: concurrency caps, the backoff curve, the DLQ, batch size, retention.

**Both live on the listener; the difference is fields vs `meta`.** Correctness options are portable fields (`key`, `attempts`), honoured by every adapter or refused at startup. What only one adapter has and only tunes it goes in that adapter's meta namespace, typed by the adapter like `meta.ai`:

```ts
export const report = listener({
  event: () => eventEmitted,
  attempts: 3,                                   // correctness: every adapter
  meta: { pgBoss: { queue: { deleteAfterSeconds: 60 } } },  // tuning: ignored by the others, and the result is still correct
  handler: ...,
});
```

Never a correctness option in `meta.<adapter>`: switching adapters would mean rewriting every listener, and `inProcess()` would ignore it in tests. Fable caught this in our own draft (`meta: { pgBoss: { policy: "key_strict_fifo" } }` is `key`). Precedent is split: Laravel's `WithoutOverlapping($key)` is job middleware that works on any driver (from its docs, not re-checked), while Rails leaves it to the adapter (Solid Queue's `limits_concurrency key:`, [README](https://github.com/rails/solid_queue)). We follow Laravel. Flat fields, not an `options: {}` group, like every definer and like Inngest `createFunction({ retries })`, Trigger.dev `task({ retry, queue })` and Oban `use Oban.Worker, max_attempts:`; a field nests only when it has sub-options (`retry: { attempts, backoff }`).

**Not every transport supports every option.** pg-boss covers all of them, going by its docs and a real app's use (retry options per job, `singletonKey`, the `key_strict_fifo` policy, `startAfter`). Cloudflare Queues takes delay per message but retries, concurrency and the DLQ per consumer; we found no per-key ordering guarantee (unverified either way; a real app's notes say per-key FIFO needs a Durable Object or ordering in Postgres). Vercel Queues has retry callbacks, delay and idempotency keys; per-key ordering is unknown. So:

- **the core enforces what it can** (`attempts`, in `jobs.run`), so adapters only map outcomes
- an adapter refuses what it can't honour in **`check({ listeners, database })`**, at `createRegistry` (Cloudflare alone refuses a `delay` over 24 hours; the outbox in front holds it instead)
- **`inProcess()` and inline tests ignore `attempts` and `delay`:** one try, right away, like Laravel's sync queue (`SyncQueue::later` ignores the delay, and sync jobs aren't retried). Not "emulates everything": that was this file's earlier claim, and it wasn't true.

### The jobs model: Laravel, as it runs on SQS

Settled on 2026-11-22. **What happens to a job once it's queued follows one model: Laravel on SQS.** We mixed Laravel, Oban and Solid Queue piece by piece before, and the pieces didn't fit together. "On SQS" matters: Laravel's own database driver has no receipt and doesn't extend ([DatabaseQueue](https://github.com/laravel/framework/blob/v13.43.0/src/Illuminate/Queue/DatabaseQueue.php)).

- **Claim:** a runner takes a job for a limited time (SQS's [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)). Taking it counts as an attempt.
- **Receipt:** each claim gets a new one ([receipt handle](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-queue-message-identifiers.html)), and only the current one can extend or finish the job. An attempt number can't do this: `retry(id)` starts them again at 1.
- **Slow:** the runner extends its time while it works, up to a maximum, as Laravel Cloud's [managed queues](https://cloud.laravel.com/docs/queues) do (three minutes at a time, on SQS). A Laravel worker can also [kill a job at its `timeout`](https://laravel.com/docs/13.x/queues#worker-timeouts) before its time runs out. JavaScript in flight can't be killed, so extending is the half we can have.
- **Time: 300 seconds, still.** It's what [Vercel's Queues SDK](https://vercel.com/docs/queues/sdk) defaults to, and it extends too. A shorter one notices a crash sooner, but loses a healthy job whose extension waits for a busy connection: with a pool of one, extending waits for the whole of a running mutation.
- **Crash:** nobody extends, the time runs out, and the next sweep retries the job, or keeps it as failed when it has no attempts left. No supervisor and no list of live processes: Workers and Vercel have neither.
- **Failed:** kept until someone retries or deletes it, like Laravel's failed jobs.

The rule: a question about a queued job's life (claim, extend, retry, fail, order) is answered by what Laravel on SQS does. Other stacks can still teach us what surrounds it (inserting in the transaction, `replace`, cron dedupe, names), not change it. One addition the database gives us: a job that is a mutation can be finished in its own transaction, which SQS can't do.

Not chosen: a fixed time with no extension ([Oban's Lifeline](https://github.com/oban-bg/oban/blob/main/lib/oban/lifeline.ex), an hour by default) has to outlast the longest job on any platform, so a crash waits that long, and a longer job is failed or run twice while it works. Solid Queue's model (a job belongs to a live process, watched by a supervisor) needs long-lived processes. Graphile Worker's `runOnce` doesn't release a crashed job's lock ([runner](https://github.com/graphile/worker/blob/main/src/runner.ts)), and that lock [lasts at least four hours](https://worker.graphile.org/docs/error-handling).

Where the outbox doesn't follow it yet: a mutation job isn't finished in its own transaction. The sections below describe the code as it is.

Evidence so far: renewal timers keep ticking during a job and inside `waitUntil` on workerd run locally. Deployed Workers and Vercel are untested.

What would change it: long-lived Node becoming the main target (then pg-boss's model), or renewal timers not holding up on workerd or Vercel (then a fixed time longer than the platform's limit, as on Laravel Vapor).

### The delivery contract (step 1 of durable events)

- **A delivery is one listener's share of one event:** `{ kind: "delivery", id: "<listener id>@<event id>", listener, envelope }`. `kind` is stored with every job, like Rails' `job_class` and Oban's `worker` column, so jobs queued today still run once scheduled calls and cron ticks exist; a kind this version doesn't know fails at once and is kept (see below). `@`, not `:`, because BullMQ rejects custom job ids containing `:` ([job ids](https://docs.bullmq.io/guide/jobs/job-ids)). Queues carry one message per delivery, so a failing listener retries alone and the id is the dedupe key every transport agrees on.
- **Three outcomes, not two.** `registry.jobs.run` resolves `"done"` or `"failed"` and throws only when a retry might help. Domain errors other than `conflict` (and a payload that no longer matches its schema) are `failed`: deterministic, so retrying burns attempts. Precedents split: Rails retries nothing unless `retry_on`, Inngest retries four times and offers `NonRetriableError`, Cloudflare retries three times by default. What would change it: an app where `not_found` heals on retry; then a per-listener opt-in.
- **`attempt` comes from the transport** (`registry.jobs.run(d, { attempt: message.attempts })`), not the stored delivery, 1-based like Cloudflare's `attempts`, and listeners see it as `ctx.event.attempt`.
- **Plain JSON at emit, for payload and scope,** in every dispatcher: a `Date` that survives `structuredClone` in-process arrives as a string through any queue and fails its schema only in production.
- **`ctx.event` carries no scope.** Once a durable dispatcher stores ids instead of the scope, listeners would otherwise see two scopes; `ctx.scope` is the one they run as.
- **`depth` rides on the envelope,** so the loop limit (`maxEventDepth`) holds across queue hops; it's checked when deliveries are built, inside the transaction, before anything is enqueued.
- **Calls due now share the chain.** A `ctx.schedule` call with no wait carries `depth` like an event (one more than the frame that scheduled it), and the function it runs passes it on. So a function that schedules itself with no delay, or an emit → listener → schedule → emit loop, stops at `maxEventDepth` and is reported, where before it ran as fast as the adapter could claim it. A call that really waits (`delay > 0`, an `at` in the future) starts a new chain: rescheduling yourself for later is the recurring pattern, not a bug. No stack we checked guards this (Laravel, Oban, Rails, Convex: Fable, from source; Convex caps 1,000 schedules per mutation); we have the counter already, so it costs a field. An outside reviewer's catch.

### The outbox (step 2)

- **Lease, not a held lock.** A runner claims a row by pushing `available_at` forward (`lease`, default 300 s) and bumping `attempts`; listeners run outside any transaction, so nothing pins a connection across network calls. pg-boss does the same (an active state with `expireInSeconds`, default 15 minutes).
- **Rows are born unclaimed; the request claims each just before it runs it.** `enqueue` writes `attempts = 0`, due in 30 seconds, so a sweep leaves them to the emitting request for that long. After commit, a fenced update (`attempts = 1 WHERE attempts = 0`) claims one job and starts its lease. It claimed the whole commit at once until 2026-11-22: a slow or dead first listener then failed the others, which had never run. Under `via` it still claims them together, for one send. The first version wrote `attempts = 1` at enqueue, so a process dying between commit and delivery spent the only try of a default listener without running it (an outside reviewer's catch). Now a crash before the claim leaves `attempts = 0`, and the sweep's claim is the first try. A crash before the claim costs those 30 seconds, not a lease.
- **Completion writes are fenced on a receipt,** new on each claim and cleared by `retry(id)`, so a listener that outlives its lease can't delete or reschedule a row a newer runner claimed. The attempt number was the fence first, and it repeats after a retry: the old runner deleted the new run's row, and that run's failure was lost.
- **The sweep claims one row at a time** (`id = (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED)`), so every claim gets a full lease. `=`, not `IN`: with `IN`, some plans run the subquery once per row and claim many rows to run one (reproduced on Postgres 17 with nested loops forced).
- **Done rows are deleted;** it's a queue, not a log. pg-boss (7 days) and Solid Queue (1 day) keep finished jobs for dashboards, which then need a pruner. Failed rows stay: `failed` means "a human might retry this".
- **Backoff:** Graphile Worker's curve, `exp(min(attempt, 10))` seconds. A listener's `attempts` decide its tries (see "Attempts and delay"); `maxAttempts` (default 10) only counts failed sends under `via`.
- **A running job extends its lease** every third of it, for 15 minutes (Workers' limit for a cron or a consumer, pg-boss's default expiry). Without a limit, a hung job would be owned for as long as the process lives. A longer job raises `lease`, which was the only answer before. Extending waits for a connection: with a pool of one, for the whole of a running mutation. What would change it: an app on long-lived Node with many jobs over 15 minutes; then the limit becomes an option.
- **The database clock,** `now()`, for leases and backoff: one clock across instances, and `ctx.now()` is frozen in tests.
- **No listing API.** The table is yours (you re-export it into your schema), so you query it with Drizzle.
- **`registry.jobs.sweep()`, not `outbox.sweep(registry)`.** The transport contract has an optional `sweep(run, options)`; the registry passes its own `jobs.run` on each call, so nothing is bound or stored and a serverless factory returns one thing. Transports that store nothing (in-process, pg-boss) resolve zeros, so a cron handler doesn't care which one you use.
- **`retry(id)` revives failed rows only** and returns whether it did. A pending row belongs to its runner or a sweep, and resetting its attempts would break the fence and run it twice at once. Oban's `retry_job` ignores available and executing jobs the same way ([Oban](https://oban.hexdocs.pm/Oban.html)). `registry.jobs.retry` throws on `inProcess()`: sweeping nothing is harmless in a cron, but retrying an id on a transport that stores nothing is a bug.
- **`expose` stays in the core, and adapters only narrow it.** It's the "may leave the process" boundary that makes `authorize` and `output` required, checked once in `createRegistry`. Adapters subtract with a `filter` (and a meta namespace when they have a per-function default, like `meta.ai.tool`), never add: an adapter publishing something not exposed would skip that check. trpc-to-openapi works the same way (a procedure reaches OpenAPI only with `meta.openapi`, on top of the router), and Convex chooses public vs internal in the core (`mutation` vs `internalMutation`). A `filter` for the fetch and oRPC adapters comes when someone needs one.

### SQLite: not yet

It's the next database after Postgres (no MySQL for now), waiting on a driver that holds up. Checked on 2026-11-22:

- **Synchronous drivers** (better-sqlite3, node:sqlite, bun:sqlite) commit before an async mutation finishes. Drizzle's types reject them in `drizzleAdapter`.
- **A local libsql file** failed 9 of 10 concurrent mutations with `SQLITE_BUSY` (0.17.4). Queueing writers in the process isn't enough: a reader open at commit, or a second writer, leaves a lock or a connection that can't commit ([352](https://github.com/tursodatabase/libsql-client-ts/issues/352), [361](https://github.com/tursodatabase/libsql-client-ts/issues/361), open and reported on 0.18.0).
- **Remote Turso** is the first candidate to prove. Untested, and its interactive transactions [time out after 5 seconds](https://docs.turso.tech/sdk/ts/reference#interactive-transactions).

What would change it: those issues fixed, or remote Turso passing the Postgres outbox's tests.

### Cloudflare Queues (step 3)

- **Two modes, one factory.** `cloudflareQueue(env.JOBS)` alone sends after commit (lossy, the Rails/Laravel model); `outbox(db, { via })` makes the handoff durable. `via` reuses the outbox's claim, fence and backoff: the only new step is "send" in place of "run", and `done` then means handed off.
- **Adapters get a `Runner` (`run`, `report`),** not a bare `run`. A failed handoff is the adapter's failure, not the listener's, so `run` never sees it; without `report` it would only land in `last_error`. Fable caught this in review.
- **`handleQueue(registry, batch)`, not curried.** The first version was `toQueueHandler(registry)(batch)`, copied from `toFetchHandler`. That one returns a router you build once; a queue handler runs per batch with a per-request registry, so the curry only added parens. Sequential, each message acknowledged on its own ([explicit acknowledgement](https://developers.cloudflare.com/queues/configuration/batching-retries/#explicit-acknowledgement-and-retries)), so one failure doesn't redeliver the batch. A throw is retried with `delaySeconds` on the outbox's curve: Cloudflare's `retry_delay` default isn't documented, and back-to-back retries would spend `attempts: 3` in seconds.
- **Structural types, no `@cloudflare/workers-types` dependency, no casts.** `body` is a `Job` because the Worker is typed `ExportedHandler<Env, Job>`; forgetting the generic is a type error, which is what we want.
- **Sends split under the limits:** 100 messages and 256,000 bytes per `sendBatch`, 128,000 per message, with about 100 bytes of metadata per message counted ("1 KB is measured as 1000 bytes", [limits](https://developers.cloudflare.com/queues/platform/limits/)). The first version used 256 × 1024 and no per-message limit; a reviewer caught it. A job over the limit throws with its size, before anything is sent.
- **Under `via`, one send per commit:** `deliver` hands all of a commit's jobs over in one call and deletes their rows in one statement. The sweep still hands off one row at a time, so one job Cloudflare rejects (too big) can't hold back the others (Fable's catch).
- **Failures past the handoff come back.** `registry.jobs.run` in a consumer calls the adapter's `fail(job, error)` when a job fails for good, and the outbox upserts a `failed` row, so querying and `jobs.retry(id)` work on Cloudflare too. Completion writes only touch `pending` rows, so a handoff whose delete lands after the consumer failed the job can't erase it. That makes a dead-letter queue optional: with `max_retries` at least the largest `attempts` (listeners, crons and `ctx.schedule` calls), Cloudflare never gives up first, and the extra delivery is what lets a crashed last try be recorded. Considered and dropped: `handleQueue(..., { deadLetterQueue })` reading the DLQ back into the outbox; with failures kept by the core, the DLQ only sees what couldn't be recorded.
- **Still true:** alone (no outbox), a failed job is acknowledged and only reported; a send that lands but whose row isn't deleted is sent again, so a job can run twice at once.
- **Not now:** lanes (a record of bindings, non-breaking later). `delay` is `delaySeconds` up to 24 hours (refused above that when alone; the outbox holds longer ones). `timeout` in core, `key` refused (ordering is best effort), `dedupe` consumer-side: when those options land.

### pg-boss (step 4)

`pgBoss(boss)` as the adapter, `work(registry, boss)` in the worker. Read from pg-boss 12.39.0's published `dist` (manager.js, plans.js), not its docs; line numbers are that version's.

- **Inserted in the mutation's transaction** with `boss.insert(queue, rows, { db: fromDrizzle(tx, sql) })`, pg-boss's own Drizzle adapter, so no outbox: Oban's model. It needs `database`, and `check` says so. pg-boss throws on an insert before `start()` (`getQueueCache` asserts its cache, manager.js:1061), so every process starts it.
- **A queue per listener and per cron, named `logic-sdk.<id>`; one shared queue (`logic-sdk.calls`) for scheduled calls.** The prefix keeps them apart from the app's own pg-boss queues (an app already on pg-boss has queues like `agents.run`, the shape of our ids), and lets `work()` find a queue of ours with jobs and no listener (renamed or removed) and report it, since pg-boss would otherwise delete those jobs unrun at expiry (plans.js:3843): the outbox fails such a job at once and keeps it. Per listener gives each its own workers and `meta.pgBoss` tuning, like a Laravel or Oban queue per job class, and our ids fit pg-boss's names (`[\w.\-/]+`, attorney.js:89). Per function would need a worker for every function that's ever scheduled; one queue keeps that to one. `work()` creates them all; an insert into a queue pg-boss doesn't know fails before any SQL (`PGBOSS_QUEUE_NOT_FOUND`, manager.js:1068), so `enqueue` creates it then and inserts again, inside the same transaction.
- **pg-boss ids are UUID v5s of ours** (`pgBossId`). pg-boss's ids are UUIDs, its insert ends in `ON CONFLICT DO NOTHING` (plans.js:2985) on `(name, id)` (plans.js:1245), so the same job id is the same row: a cron minute ticked by every worker inserts once, the outbox's `logic_cron_runs` for free. Finished jobs stay 7 days (`deleteAfterSeconds`), which covers a late tick.
- **Tries stamped at insert:** `retryLimit = attempts - 1` and `retryBackoff: true` on every row (pg-boss's default is a retry at once: `retryDelay` 0). `attempt` is pg-boss's `retryCount + 1`, which goes up each time a started job is fetched again (plans.js:2614).
- **Failed for good is pg-boss's `deadletter`,** with `perJobResults`: it fails the job terminally whatever its retries (`failJobsBody`'s `forceTerminal`, plans.js:3193), and copies it to the queue's `deadLetter` if there is one. Plain `failed` would retry a domain error. A throw is `failed`, so pg-boss retries it. The error goes in the job's `output`: `work()` passes its own `fail` to `registry.jobs.run`, which the core calls before it resolves `failed`.
- **Crons are ticked, not `boss.schedule`d.** `work()` runs `startTicking` with no sweep; the uuid ids dedupe across workers. pg-boss's schedules parse with cron-parser, which runs a repeated local hour once (timekeeper.js:137), where ours run it twice, like Laravel; two parsers would also disagree on what each accepts, and a cron would behave differently per adapter. The cost: a worker per process ticks, which is a cheap insert.
- **`retry(id)` gives a fresh set of attempts,** like the outbox. Laravel's `queue:retry` sets the payload's `attempts` to 0 (`RetryCommand::resetAttempts`, 12.x) and Solid Queue's `FailedExecution#retry` calls `job.reset_execution_counters` (main). pg-boss's `retry` adds one to `retryLimit` and keeps `retryCount` (plans.js:3961), so the next try's `attempt` would be past `attempts` and the core would fail it unrun. So, in one transaction: pg-boss's `retry` (only `failed` rows, so only one `retry(id)` wins, and its row lock keeps workers off, since they fetch `SKIP LOCKED`, plans.js:2464), then delete and insert the row as new. Its replace key goes, as in the outbox.
- **`replace` deletes the waiting call and inserts the new one, rather than pg-boss's `upsert`.** `upsert` by `singletonKey` edits a `created` or `retry` job in place (plans.js:3997, manager.js:1799): it keeps the old id, so `retry(id)` with the id `ctx.schedule` returned finds nothing, and it would edit a call in `retry`, which has started. Instead, per key in key order: a transaction-scoped advisory lock (without it, three concurrent replacers left three waiting calls on Postgres, in a test), a no-op `update` by key that row-locks the queued jobs so no worker starts one, then delete the `created` ones among them. A call in `retry` is left alone.
- **`deliver` is a no-op,** not optional in the contract: making it optional typed `outbox`'s `via` and `cloudflareQueue` to require it, more change than a one-line no-op. **No `sweep`:** pg-boss's supervisor expires and retries jobs itself (plans.js:3117), so `registry.jobs.sweep()` resolves zeros.
- **A crash on the last try is pg-boss's:** its supervisor fails the expired job (retries used) without our code running, so `onError` doesn't hear about it. The outbox's last-try check never triggers here.
- **Not in v1:** `policy` (so no `key_strict_fifo` per-key order until `key` lands as a listener field). Crons have no `meta`, so `work(..., { crons })` tunes all their queues, as `{ calls }` does the calls queue.
- **What would change it:** pg-boss gaining an upsert that sets the id, or a retry that resets the count (then `replace` and `retry` become one call each); an app with hundreds of listeners, where a worker per queue costs too many connections (then a shared queue with a `route`).

### Attempts and delay

```ts
listener({ event: () => orders.placed, attempts: 5, delay: 60, async handler(ctx, payload) { ... } });
```

- **Total tries, not retries,** like Laravel's `$tries` / `#[Tries]`, Oban's `max_attempts` and Rails' `retry_on attempts:` (which "includes the original job execution"). Sidekiq, pg-boss, Cloudflare and Inngest count retries; two conventions in one app is how off-by-ones happen.
- **Default 1.** Checked on each project's default branch: Active Job doesn't retry without `retry_on` ("A failed job will not be retried, unless configured otherwise"), Solid Queue "doesn't include any automatic retry mechanism", Laravel's worker has `--tries=1`, BullMQ `attempts` defaults to 1. Oban defaults to 20, pg-boss to 3, Cloudflare to 4 deliveries, Inngest to 5. We follow Rails and Laravel: a retry repeats side effects, so it's opt-in per listener. What would change it: apps where most listeners are idempotent API calls that fail transiently.
- **The core enforces it, in `jobs.run`:** a retryable failure on the last try resolves `failed`; a job claimed past its last try (`attempt > attempts`: it crashed, or outlived the lease) is `failed` without running. Laravel's worker does the second at pickup (`markJobAsFailedIfAlreadyExceedsMaxAttempts`), and Solid Queue fails a dead worker's jobs without retrying them. Living in the core, one rule covers the outbox (which counts a try when it claims) and Cloudflare (which counts deliveries). A job past the outbox's maximum extension is therefore failed though it may still succeed: better than running it twice, and documented next to `lease`.
- **Stamped on the job when it's queued** (`job.attempts`), like Laravel (`maxTries` in the payload, read back by the worker: `Queue.php:183`, `Worker.php:732` on 13.x) and Oban (`max_attempts` on the row, settable per insert). Rails' `retry_on` reads the class at run time instead. We first read it from the code, so a deploy applied to queued jobs; two things reversed that. pg-boss needs `retryLimit` at insert, so with code-read tries the two would disagree after a deploy. And `ctx.schedule` calls have no definition to read them from (`{ attempts }` is per call, like Oban's `Worker.new(args, max_attempts: n)`). One rule for every adapter beats a rule per adapter. The cost: a deploy that raises or lowers `attempts` applies to jobs queued after it, not before. What would change it: an app that needs to raise the tries of jobs already queued (today: `retry(id)` once they fail).
- **`delay` is stamped, as `runAt`** (`occurredAt + delay`, the registry's clock), because it's a fact about one job, not a rule about the code. The outbox writes delayed rows unclaimed (`attempts 0`, `available_at = runAt`) and a sweep runs them; Cloudflare gets `delaySeconds`.
- **`onError` gets `outcome`** (`"retry"`, `"failed"`, `"discarded"`), so alerting can skip tries that will be retried.
- **`onError` gets the job itself (`info.job`), and `source` names who failed.** Laravel's `JobFailed` carries the job instance ([JobFailed.php](https://github.com/laravel/framework/blob/12.x/src/Illuminate/Queue/Events/JobFailed.php)) and Oban's `[:oban, :job, :exception]` telemetry the `Oban.Job` ([Oban.Telemetry](https://oban.hexdocs.pm/Oban.Telemetry.html)), so a handler reads the kind, input or envelope without a lookup. The first names (`listener`, `delivery`) predate crons and calls and held their ids too. When an adapter can't take a commit's jobs, each one is reported (`source: "(dispatcher)"`), since each may be lost. The outbox column is `job` for the same reason.
- **A job this code can't run fails at once and is kept.** Its listener was renamed or removed, or its kind is unknown. Rails does this: Solid Queue's `ClaimedExecution` raises `ClassMissingError` ("renamed or removed in a deploy while jobs referencing it were in flight") and records a failed execution, revived by hand. Oban retries an unknown worker up to `max_attempts`, which self-heals a rolling deploy; we follow Rails because the first version retried, and a job that waited out a bad deploy then arrived past its last try and was failed with zero runs (Fable's audit). Where it bites: a rolling deploy where an old process sweeps jobs for a listener only the new code has (delayed jobs and retries always go through a sweep), and `cloudflareQueue` alone, where such a job is acknowledged and only reported, where before it reached the dead-letter queue. A job's first try without `via` runs in the process that emitted it, so it's safe. `registry.jobs.retry(id)` revives it, and `last_error` says why.
- **A throw from `jobs.scope.load` counts as a try,** like one from the listener: it's part of running the job, and at the default of one, any failure fails.
- **Adapters keep failures through `run`'s `fail` callback,** with the real error, instead of writing a generic one after `run` resolves.

### Tests: hooks, and jobs inline or manual

- **`beforeEach(() => t.begin())` and `afterEach(() => t.rollback())`, not a callback per test.** Checked: Rails wraps every test in a rolled-back transaction by default (`use_transactional_tests`, default true); Laravel opts in per test class with the `RefreshDatabase` trait; Phoenix generates a `DataCase` with the sandbox in `setup`, and each file `use`s it; convex-test starts a fresh backend per test. Hooks fit all of them. Drizzle transactions are callbacks, so `begin` parks one on a promise until `rollback`.
- **No footguns:** without `begin`, `t` throws with the hooks to add, instead of writing to the real database; `begin` twice (concurrent tests sharing `t`) throws and names the cause.
- **`jobs: "inline" | "manual"`,** Oban's `testing:` modes, replacing `listeners: boolean`. Manual keeps jobs in `t.jobs.queued`; `drain()` (Oban's `drain_queue`, Rails' `perform_enqueued_jobs`) and `perform(listener, payload, { scope })` (Oban's `perform_job`) run them. The app's adapter is never used in tests.
- **A failing listener fails the test:** `t.as().run`, `drain` and `perform` throw its error, while production keeps "listeners never fail the caller". Fable's catch: swallowed failures let a broken listener pass. `waitUntil` is off in tests, so listeners finish inside the call.

### Naming the slot: `jobs`

```ts
createRegistry({ modules, database, jobs: { adapter: outbox(db), scope: { store, load } } });
await registry.jobs.sweep();                                          // a cron or an interval
await registry.jobs.retry(id);                                        // failed jobs only; false otherwise
await registry.jobs.run(message.body, { attempt: message.attempts }); // a queue consumer
registry.definitions.listeners;                                       // and functions, events: what adapters and plugins read
```

The slot is `jobs`, not `queue`: every method on it acts on a job, and in every reference stack a "queue" is a named lane inside the adapter, a word we keep free for routing.

**The rules, in order:**

1. **A word names one kind of thing.** A namespace holding its own unit is fine (`registry.jobs` holds jobs); one word for a definition and for infrastructure isn't.
2. **Definers take domain words** (`query`, `mutation`, `action`, `event`, `listener`, `cron`); **slots take infrastructure words.**
3. **The stacks' idiom, not the literal mechanism.** What the slot holds today is deliveries; what people call that work is jobs.
4. **It survives the roadmap:** deliveries now, then `ctx.schedule(fn, input, { at })` calls and, where the transport stores them (pg-boss), cron ticks. All three are jobs.
5. **It reads well in every position:** the option, `registry.jobs.sweep()`, the `Job` type, logs, docs.
6. **Precedent in stack order.** Vercel, TanStack and Convex have no transport slot (Convex has `ctx.scheduler` and `crons.ts` on its own infrastructure), so Rails, Laravel and Adonis decide. Rails: `config.active_job.queue_adapter`, default `:async`, in-process and lost on restart ([AsyncAdapter](https://api.rubyonrails.org/classes/ActiveJob/QueueAdapters/AsyncAdapter.html)). Laravel: `config/queue.php` connections, jobs dispatched onto named queues ([queues](https://laravel.com/docs/13.x/queues)). Adonis: `config/queue.ts` with `adapters` and `queues`, job classes in `app/jobs/`, experimental ([queues](https://docs.adonisjs.com/guides/digging-deeper/queues)). All three call the unit a job and a queue a lane.

**Rejected:**

- `events`: fails 1, 2 and 4. `event` is a definer, the slot will carry scheduled calls and cron ticks that aren't events, and `registry.events` listed definitions.
- `delivery`: fails 4 to 6. A scheduled call isn't a delivery, `registry.delivery.run(delivery)` stutters, and no stack uses it.
- `queue`: the closest second. It's the adapter's config name in Rails and Laravel, but there it holds named queues, and lanes are something we'll want (`route` below).
- `dispatcher`, `background`: describe the mechanism or an adjective, not the thing you act on.

**An object: the adapter, plus what every adapter honours.** We first shipped a single value (`jobs: outbox(db)`) on the claim that no setting survives every adapter. Reading the configs says otherwise:

| | Common to every adapter | Adapter-specific | Per job, never in config |
|---|---|---|---|
| Laravel ([`config/queue.php`](https://github.com/laravel/laravel/blob/13.x/config/queue.php)) | `driver`, `queue`, `after_commit` | `table`, `region`, `block_for` | `$tries`, `$backoff` |
| Rails ([configuring](https://guides.rubyonrails.org/configuring.html#configuring-active-job)) | `queue_adapter`, `default_queue_name`, `queue_name_prefix`, `enqueue_after_transaction_commit` | the adapter's own file (`config/queue.yml`) | `retry_on`, Solid Queue's `limits_concurrency` |
| Oban ([`config.ex`](https://github.com/oban-bg/oban/blob/main/lib/oban/config.ex)) | `engine`, `queues`, `prefix`, `testing` | engine options | `max_attempts`, `unique` on the worker |

So: lanes, commit timing and test mode are common; retries never are. Ours:

- **`adapter`** (Rails' word, and ours already: `drizzleAdapter`). Its own options go in its factory, `outbox(db, { lease })`, not a `driver: "database"` string with a typed union: Laravel can use strings because its container builds the client, and we have none. The pg-boss instance, your `db`, a Worker's per-request binding come from your code, and adapters are subpaths with optional peers the core can't type.
- **`scope`**, applied by the core in every adapter ("Before durable events ship", 4).
- **Later `queue`**, the default lane, when lanes land. Commit timing is the contract, test mode is `createTestRegistry`.
- **Object only, no `jobs: outbox(db)` shorthand.** Adding a shorthand later breaks no one; removing one does. Fable preferred keeping both, for brevity when there's no `scope`.
- **Wrapping still composes adapters:** `outbox(db, { via: cloudflareQueue(...) })`, since sibling fields (`{ adapter, store }`) could express nonsense.

**Lanes (multiple queues)** are normal in every stack, for isolation, priority, per-lane concurrency and retry policy. Ours is a `route` in the transport, with no core change: `cloudflareQueue({ jobs: env.JOBS, mail: env.MAIL }, { route })`, `pgBoss(boss, { route })`. `inProcess()` and plain `outbox(db)` have none; an unknown lane throws. Built with the Cloudflare and pg-boss transports, when the first app needs a second lane. **What would move the lane onto the listener** (`listener({ queue: "mail" })`): two transports implementing lanes, or routing by id prefix getting brittle.

**`registry.definitions`** holds the lists (`functions`, `events`, `listeners`, later `crons`), so the registry's top level is what you call (`as`, `jobs`, `idOf`) and a new definer adds a list without taking a name there.

**What would change it:** a `job()` definer (then `jobs` would name a definition and the infrastructure).

### Before durable events ship

From Fable's review, each with what the mature stacks already learned. **Landed with the delivery contract:** 1, 2 and 6, plus the stale-payload half of 5 (a payload that fails its schema at delivery is `failed`, not retried) and the plain-JSON check from 4. **With the first durable transport:** 3, `store`/`load` from 4, and the failed state from 5.

1. **Deliver per (event, listener), not per event.** Today one failing listener makes the healthy ones re-run on retry. Rails, Laravel and Oban all make the job the unit; a listener is our job.
2. **Let transports acknowledge.** `deliver` gets a `dispatch` that never throws, so a queue adapter can't ack or retry a message, while `registry.dispatch` throws: two paths with different rules. One dispatch that returns per-listener results, with `inProcess` doing the swallowing.
3. **Stable ids. Landed:** an optional `id` on every definer (`listener({ id: "send" })`), local to the module so `notifications` + `"send"` is `notifications.send`. Jobs store listener ids and event names, and a rename orphans them in flight: Rails raises `UnknownJobClassError` ([core.rb](https://github.com/rails/rails/blob/main/activejob/lib/active_job/core.rb)), Oban "unknown worker" ([worker.ex](https://github.com/oban-bg/oban/blob/main/lib/oban/worker.ex)); Inngest's function id "should not change between deploys", and Trigger.dev's task id is top-level too. A core field, not `meta`: the core reads it for lookup, dedupe and errors, and meta is what the core never reads. Local, not full: a full id would let `billing` claim `notifications.send`, and `ctx.errors` codes assume the module prefix. Duplicates throw at `createRegistry`. Renaming a module key still orphans jobs; a CLI rename check or `aliases` comes if that bites.
4. **Scope at rest goes stale.** The envelope stores a copy of the caller's scope, so a retry days later runs with old roles. Precedents split (RESEARCH.md, "Scope at rest"): Convex carries nothing, Laravel's Context carries a snapshot of what you put in it, Fizzy carries only the account and reloads it. Least machinery that's still safe, **landed** on the registry, not the adapter: the core applies `store` at emit and `load` in `jobs.run`, so `inProcess()` and tests exercise the same projection, and `outbox(db, { via })` never asks whose scope wins. (We first had it on each durable adapter, because only they store scope; that repeats it per factory and skips it in tests.)

   ```ts
   jobs: {
     adapter: outbox(db),
     scope: {
       store: (s) => ({ userId: s.user?.id ?? null, accountId: s.accountId, locale: s.locale }), // optional: what's saved
       load: async (stored) => scopeFor(stored),                                             // optional: rebuilt fresh at delivery
     },
   }
   ```

   - **On `inProcess()`, the scope as-is,** what `emit` already stores (every other adapter requires `load`, below). Checked to be plain JSON at emit in every dispatcher, `inProcess()` and tests included, so a `Date` or class instance fails in tests, not in production.
   - **`store` is a projection:** keep ids, drop what shouldn't sit in an outbox table or a third-party queue (emails, session data).
   - **`load` rebuilds fresh,** so every `ctx.run` re-checks policies with today's roles. `null` discards: a `"discarded"` outcome, reported to `onError`, the outbox row deleted and counted by `sweep`. Rails' `discard_on` and Laravel's `DeleteWhenMissingModels` discard silently and are opt-in; returning `null` is the opt-in. Fable argued for `failed` instead (visible, retryable), so offboarding can't silently eat work; we followed the stacks and report it. A throw retries.
   - Crons resolve their scope in code and store nothing.
   - **`load` is required with every adapter but `inProcess()`** (the outbox, `cloudflareQueue`, pg-boss, anything hand-rolled). Keyed on "not inProcess()" rather than on `holds`, so an adapter that forwards jobs to a queue and forgets to declare anything still gets the check (Fable). The default snapshot is what goes stale, and the stacks that carry a "who" into jobs rebuild it: AshOban's `actor_persister` (`store(actor)` / `lookup(json)`, nearly our shape, and the one stack that also re-authorizes inside jobs; its guide warns the actor's rights may no longer hold "even across retries"), stancl/tenancy and Spatie (re-find the tenant on `JobProcessing`), Rails' GlobalID and Laravel's `SerializesModels` (store ids, re-find at run). Sidekiq's `CurrentAttributes` carries a snapshot, opt-in. Convex carries nothing, so its scheduled functions run as trusted code. Considered: jobs run as the system with the actor as data (Convex's model); rejected because every policy a listener touches would need a system grant, and a user's event could trigger work they couldn't do themselves. `inProcess()` stays optional: nothing waits. The escape hatch is written down, `load: (saved) => saved`. What would change it: apps where nearly every scope is immutable ids and the line is pure ceremony; then a check warning instead.
5. **Old payloads after a deploy.** Payloads are validated again at delivery, so a schema change can turn queued messages into poison that retries forever. Laravel stores exhausted jobs in `failed_jobs` (`queue:retry` re-runs them) and can discard jobs whose model is gone; Oban marks jobs `discarded` after `max_attempts`; Solid Queue doesn't auto-retry a job whose process died. We need the same: a failed state you can list and retry, and a versioning rule for payloads.
6. **A real event depth on the durable path.** `Envelope` needs `depth` and `attempt`; today `registry.dispatch` starts every stored envelope at depth 1, which loses the loop limit across hops. (Listener `meta` in `wrap` landed with `listener({...})`.)
