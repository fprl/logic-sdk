# Why logic-sdk

What you get, what you'd otherwise hand-roll, and what you give up. Each item is marked:

- **✅ shipped:** in the code and tested
- **🛠 planned:** in ROADMAP.md, not built yet

## 1. Convention over configuration, without the magic

Rails' superpower was that anyone could open any app and know where things go. This gives TypeScript that for your business logic.

- ✅ **One folder shape for every module:** `queries.ts`, `mutations.ts`, `actions.ts`, `events.ts`, `listeners.ts`, `data.ts`, `schema.ts`. Where code goes follows from what it touches, not from taste.
- ✅ **Registration is automatic.** Export a listener and it's live. Add a module with one line in `createRegistry`. There's no route table, job list or listener array to keep in sync.
- ✅ **Explicit instead of callbacks.** A `mutation` shows everything it does in its body (`run`, `emit`). There are no `after_save` hooks firing from somewhere else.
- 🛠 `logic-sdk init` scaffolds `logic.ts`, `registry.ts`, the lint config and a managed block in your AGENTS.md that points agents at the skill.

*Instead you'd:* hold a team discussion per project about "services vs use-cases vs actions", and get a different answer each time.

## 2. Correct by default

The bugs every hand-rolled service layer eventually ships, made impossible or loud:

- ✅ **One transaction per top-level mutation.** Nested mutations join it.
- ✅ **A caught nested failure can't commit partial writes.** The transaction is doomed. Rails commits in this case, and Ecto aborts like we do.
- ✅ **Events only leave after commit.** No email for a booking that rolled back.
- ✅ **Nothing after commit can fail the caller.** Listener, dispatcher, `waitUntil` and `onError` failures are all reported, never thrown.
- ✅ **No side effects in a transaction**, at the type level: mutations and queries get no `services`. So you never hold a transaction open across a Stripe call, and mutations are safe to re-run.
- 🛠 Automatic retry on deadlocks and serialization failures (40001/40P01), which follows from the rule above.

*Instead you'd:* write `db.transaction` everywhere, pass `tx` through every helper, keep an after-commit array per request, and remember all of this in every PR.

## 3. Secure by default

- ✅ **Private by default, exposed on purpose.** `authorize: staff` says who may call a function; `expose: true` lets adapters publish it, and can't be set without `authorize`. Without `expose`, no adapter publishes it and the typed oRPC router doesn't contain it.
- ✅ **Policies are written once and narrow types.** A `staff` function gets a non-null `scope.actor`, because its policy runs on every call, nested ones too.
- ✅ **Record rules the Rails way.** Load through a scoped helper (404 for other accounts), then a sync `can*` check (403), reused for UI flags. The CLI keeps `can*` checks sync and used.
- ✅ **Scope is explicit and typed:** actor, tenant, locale. Row-level tenancy lives in `data.ts` helpers that take `scope.accountId`.
- ✅ **Acting as someone else is explicit, per call, and visible:** `ctx.run(fn, input, { scope: { actor } })`. Checks see the new scope, and `logic-sdk show` lists the change on that run.

## 4. Testing without mocks

- ✅ **Real database, and each test is a transaction that's always rolled back.** Tests are fast, isolated and need no cleanup.
- ✅ **Every top-level mutation inside a test is a savepoint**, so a failing mutation rolls back only its own writes, as in production.
- ✅ **`t.events`** records every committed event. Assert on what happened instead of querying a job table.
- ✅ **`{ jobs: "manual" }`** tests one module in isolation, like Oban's manual mode: jobs wait in `t.jobs.queued` until `drain()`. By default listeners run inline, and a failing one fails the test.
- ✅ **Services are injected.** Pass `memoryMailer()` or a scripted LLM per test instead of spying on modules.
- ✅ **`t.stub(fn, impl)`** replaces one function by identity, for example to simulate another module failing.
- ✅ **Time is frozen** via `ctx.now()`.

*Instead you'd:* write per-job fixtures to find and perform queued work, spy on modules, and isolate tests with random ids.

## 5. Change stacks without touching your logic

- ✅ **Modules never import a framework.** Moving SvelteKit → Hono → Next means rewriting edge files only.
- ✅ **Runs on Node, Bun and Cloudflare Workers.** No `node:` imports, no AsyncLocalStorage.
- ✅ **Adapters:** fetch handler, oRPC v2 (typed client, OpenAPI and MCP through oRPC).
- ✅ **Database adapter seam:** Drizzle today.
- ✅ **Dispatcher seam:** in-process today, 🛠 Postgres outbox and pg-boss later, with no changes to mutations or listeners.

## 6. One way to call your logic, from anywhere

- ✅ **`registry.as(scope).run(fn, input)`** is the same call from HTTP, RPC, a cron job, a script, a test or a webhook.
- ✅ **The same validation, authorization, transactions and events apply** on every path.
- 🛠 `toAITool(caller, fn)` and `toAITools(registry, caller, { filter })`: an AI agent calls the same functions with the same rules, and only the ones you opt in.

## 7. Observable

- ✅ **`wrap(call, next)`** sees every call, including denied and invalid ones, with id, kind, depth and scope. One hook covers logging, tracing, metrics and audit.
- 🛠 `logic-sdk graph` prints who runs what and which events reach which listeners. `logic-sdk inspect` shows a live call tree.

## 8. Errors that mean something

- ✅ **One `DomainError`** with `kind` (`invalid`, `rejected`, `forbidden`, `not_found`) and a namespaced `code`. Adapters map kinds to 400/422/403/404.
- ✅ **Unexpected errors become 500s** without leaking details. Invalid output or event payloads are treated as bugs, not 400s.

## 9. Built for AI-written code

- ✅ **Uniform shape, a one-sentence JSDoc on every function, an agent skill.** An agent can't invent a new architecture per feature.
- ✅ **The lint rule blocks cross-module imports.**
- 🛠 Skills shipped in the package (TanStack Intent), and `logic-sdk check`, which fails on cycles and on side effects in mutations. The agent writes the code; the lib verifies it followed the rules.

## What you give up

- **Drizzle is the only adapter shipped so far.** You write your queries in your ORM; the lib never generates SQL. It only needs to open a transaction and nest one (a savepoint), which is two methods. Kysely, and Prisma since 7.5 (nested savepoints), are short adapters. Drivers without interactive transactions (D1, HTTP drivers) can't work.
- **`run(fn, input)` to cross modules.** This is the same as Convex's `ctx.runMutation(internal.x.y, args)`, and it follows Convex's own advice: plain helper functions that take `ctx` inside a module, `run` only across modules.
- **Listeners run in-process by default**, like Laravel's sync listeners or Rails `after_commit` callbacks. If the process dies during a listener (a deploy, OOM, a serverless timeout), that work is lost. For work that matters, `outbox(db)` writes each job in your transaction and retries it (`attempts` on the listener), with no changes to mutations or listeners. pg-boss is planned.
- **It's the business-logic layer only.** It owns your business rules, transactions, events and jobs. It doesn't do HTTP routing, sessions and login, schema and migrations, or UI: you bring Hono or SvelteKit, Better Auth, Drizzle. Same idea as the AI SDK, which doesn't render your chat UI.
