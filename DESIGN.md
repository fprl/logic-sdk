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
- **Adapters own a namespace in your meta and export its type.** `logic-sdk/ai` exports `AIMeta = { ai?: { tool?, description? } }`; you add it to your shape (`meta: AIMeta & AppMeta`). Meta stays yours: the library reserves no key, so nothing collides with your own `description`.
- **Options last override meta,** for every adapter: `toAITool(caller, fn, { description })`, or `describe: (f) => …` on `toAITools` (the bulk form), then `meta.ai.description`, else none. `toAITools` defaults `filter` to `meta.ai.tool === true`, so the agent door stays opt-in without a key of your own.
- **Costs, accepted:** nothing flags a tool without a description (models pick worse; a `check` rule could warn later), and definition-time errors name "a mutation", not its sentence (the stack trace locates it).
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
type Config = { scope: Scope; db: Tx; services: Services; plugins: [Audit, RateLimit] };   // types only
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
- **Types:** `MetaOf<C>` adds `{ [P in Plugins as P["name"]]?: P["meta"] }`, and the ctx per kind adds `{ [P in Plugins as P["name"]]: P["ctx"][K] }`, so a plugin can add to mutations only.
- **Runtime:** `{ name, wrap?, ctx?: { query?, mutation?, action? }, onRegister? }`. `wrap` is the existing hook; `onRegister` sees every definition, for checks like "every exposed mutation has a rate limit".
- **Jobs are core, not a plugin.** Scheduling needs the transaction handle, which is the dispatcher's seam.
- **What would change it:** a plugin whose ctx type depends on per-function order. Same test as middleware above.

### Durable events: a ladder, composed by wrapping

Configured once, where the registry is created:

```ts
createRegistry({ modules, events: inProcess() });                        // default: zero infra, lost on a crash
createRegistry({ modules, events: cloudflareQueue(env.EVENTS) });        // sent after commit: the Rails/Laravel model, lossy
createRegistry({ modules, events: outbox() });                           // durable, Postgres only
createRegistry({ modules, events: outbox(cloudflareQueue(env.EVENTS)) }); // durable handoff, plus queue retries, DLQ, concurrency
createRegistry({ modules, events: pgBoss(boss) });                       // transactional natively, no outbox needed
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
- **The library declares; the platform triggers:**
  - Node with pg-boss: the adapter calls `boss.schedule`, which dedupes across instances.
  - Cloudflare: `scheduled: (c) => registry.crons.handle(c.cron)`, with the expressions listed in wrangler `triggers.crons`.
  - Vercel: one route, `/api/logic/cron/[name]`, listed under `schedules` in `vercel.json` (Cron Jobs are now legacy there).
- **Open:** a CLI drift check (a wrangler deploy replaces all triggers, so a missing one is a silently dead cron). Maybe later, maybe too much.

### Options: correctness in code, tuning in infra

**The rule:** if an option changes whether the result is correct, it belongs on the listener, in code, chosen by you. If it changes capacity or operations, it belongs to the transport or the platform config. Laravel draws the same line: a job's `$tries` beats the worker's `--tries`, while Cloudflare and Oban put concurrency in queue config.

| On the listener | Meaning |
|---|---|
| `retries` | how many times to retry after a failure |
| `delay` | run it N seconds after the event |
| `key` | same key runs one at a time, in order (per conversation, per account) |
| `dedupe` | never run twice for the same event; defaults to event id plus listener id |
| `timeout` | give up after N seconds |

Transport side: concurrency caps, the backoff curve, the DLQ, batch size, retention.

**Not every transport supports every option.** pg-boss covers all of them, going by its docs and a real app's use (retry options per job, `singletonKey`, the `key_strict_fifo` policy, `startAfter`). Cloudflare Queues takes delay per message but retries, concurrency and the DLQ per consumer; we found no per-key ordering guarantee (unverified either way; a real app's notes say per-key FIFO needs a Durable Object or ordering in Postgres). Vercel Queues has retry callbacks, delay and idempotency keys; per-key ordering is unknown. So:

- each transport declares **capabilities**
- a correctness option it can't honour (`key`, `dedupe`) **throws at `createRegistry`** and fails `check`
- a tuning option it can't honour is emulated where the library can (retries via ack and retry), otherwise warned once
- **never ignored silently.** `inProcess()` emulates everything naively, so tests behave the same whatever production uses.

### Before durable events ship

From Fable's review, each with what the mature stacks already learned:

1. **Deliver per (event, listener), not per event.** Today one failing listener makes the healthy ones re-run on retry. Rails, Laravel and Oban all make the job the unit; a listener is our job.
2. **Let transports acknowledge.** `deliver` gets a `dispatch` that never throws, so a queue adapter can't ack or retry a message, while `registry.dispatch` throws: two paths with different rules. One dispatch that returns per-listener results, with `inProcess` doing the swallowing.
3. **Stable listener ids.** Ids are export names; with durable delivery they become queue or consumer names, and a rename orphans messages in flight. Inngest's function id "should not change between deploys". An optional `id`, or a CLI check on renames.
4. **Scope at rest goes stale.** The envelope stores a copy of the caller's scope, so a retry days later runs with old roles. Precedents split (RESEARCH.md, "Scope at rest"): Convex carries nothing, Laravel's Context carries a snapshot of what you put in it, Fizzy carries only the account and reloads it. Least machinery that's still safe, configured on the dispatcher because only durable ones store scope (`inProcess()` delivers milliseconds later in the same request):

   ```ts
   events: outbox({
     scope: {
       store: (s) => ({ userId: s.user?.id ?? null, accountId: s.accountId, locale: s.locale }), // optional: what's saved
       load: async (stored) => scopeFor(stored),                                             // optional: rebuilt fresh at delivery
     },
   })
   ```

   - **Default: the scope as-is,** what `emit` already stores. Checked to be plain JSON at emit in every dispatcher, `inProcess()` and tests included, so a `Date` or class instance fails in tests, not in production.
   - **`store` is a projection:** keep ids, drop what shouldn't sit in an outbox table or a third-party queue (emails, session data).
   - **`load` rebuilds fresh,** so every `ctx.run` re-checks policies with today's roles. `null` discards (recorded, reported to `onError`), a throw retries, like Rails' `discard_on` and Laravel's `DeleteWhenMissingModels`, which are opt-in too.
   - **`logic-sdk check` prints it** next to the delivery guarantee: "scope at rest: snapshot" or "rebuilt".
   - Crons resolve their scope in code and store nothing. What would make `load` required for at-least-once dispatchers: an app where revoking access must stop queued work (B2B offboarding with retries over days).
5. **Old payloads after a deploy.** Payloads are validated again at delivery, so a schema change can turn queued messages into poison that retries forever. Laravel stores exhausted jobs in `failed_jobs` (`queue:retry` re-runs them) and can discard jobs whose model is gone; Oban marks jobs `discarded` after `max_attempts`; Solid Queue doesn't auto-retry a job whose process died. We need the same: a failed state you can list and retry, and a versioning rule for payloads.
6. **A real event depth on the durable path.** `Envelope` needs `depth` and `attempt`; today `registry.dispatch` starts every stored envelope at depth 1, which loses the loop limit across hops. (Listener `meta` in `wrap` landed with `listener({...})`.)
