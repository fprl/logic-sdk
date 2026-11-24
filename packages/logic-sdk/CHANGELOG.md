# logic-sdk

## 0.6.1

### Patch Changes

- 3ebed81: `fn.input` is the schema as you wrote it, so a form can derive from the function it calls: `properties.update.input.pick({ name: true })`, with no schema exported for it. It's `undefined` when the function takes no input. `Fn` gets a sixth type parameter for it, defaulting to `Schema | undefined`, and `input` is no longer optional on the type.
- @logic-sdk/cli@0.6.1

## 0.6.0

### Minor Changes

- e7964b8: `cron({ run })` takes a thunk, like a listener's `event`: `cron({ schedule, run: () => reports.sendWeekly, scope })`. It's read when the registry is built, so no definer reads an import while files load, and import cycles between a module's files are harmless at runtime. Breaking: `run: fn` becomes `run: () => fn`.

### Patch Changes

- 9946bd4: `ctx.run` nests at most 64 calls deep. Past that it throws a plain error with the last calls of the path (`… → a.ping → b.pong → a.ping`), instead of a function that runs itself, directly or through other modules, running until memory runs out. Recurse in a helper that takes `ctx`, or make each step an event or `ctx.schedule`.
- e453d76: The agent skill and the README no longer mention `logic-sdk check`: done means `tsc` and the tests pass.
- Updated dependencies [e7964b8]
- Updated dependencies [e453d76]
  - @logic-sdk/cli@0.6.0

## 0.5.0

### Minor Changes

- fa397fa: Background work in your database, and publishing on purpose.

  **Jobs.** Listeners, crons and scheduled calls run as jobs, through an adapter you pick: in the request (`inProcess()`, the default), in your own database (`databaseQueue(database)`), or a queue behind an outbox (`outbox(database, queue)`), pg-boss, or Cloudflare Queues. In your database, a job's life follows Laravel's queue worker on SQS: a claim with a lease that a running job extends, tries you opt into, a backoff between them, and a failed state you can retry.

  ```ts
  const database = drizzleAdapter(db); // logic-sdk/drizzle/pg, or logic-sdk/drizzle/sqlite
  export const registry = createRegistry({
    modules,
    database,
    jobs: { adapter: databaseQueue(database), scope: { store, load } },
  });

  export const flagFraud = listener({
    event: () => orders.placed,
    when: (order) => order.total > 5000, // only these orders get a job
    attempts: 3,                         // tries in total; default 1
    delay: 60,                           // seconds after the event
    async handler(ctx, order) { ... },
  });
  export const digest = cron({ schedule: "0 8 * * 1-5", timezone: "Europe/Madrid", run: reports.send, scope: system });
  ctx.schedule(guests.remind, { bookingId }, { at: dayBefore(checkIn), replace: bookingId }); // from a mutation
  ```

  - **`registry.jobs`:** `run(job, { attempt })` for a queue consumer, `sweep()` for what's due (retries, crashed runners), `retry(id)` for a failed job, `tick(at)` for crons. `startTicking(registry)` from `logic-sdk/node` runs ticks and sweeps in a long-lived process; `handleQueue` and `handleScheduled` from `logic-sdk/cloudflare` do it on Workers; `work(registry, boss)` from `logic-sdk/pg-boss`.
  - **A job runs as the scope `jobs.scope.load` rebuilds,** with today's roles (`null` discards it). `store` picks what's saved. Every adapter that keeps jobs requires `load`, by type and at startup.
  - **Every queued job carries its id and tries.** Definers take an optional `id`, so renaming an export doesn't orphan queued jobs. A job whose code this process doesn't have uses its attempts, so a rolling deploy can run it. A job is settled before the jobs it queued run.
  - **Crons:** five-field schedules in a time zone, each minute once across servers with `databaseQueue`, `outbox` or pg-boss.
  - **`ctx.schedule(fn, input, { at | delay, attempts, replace })`** runs a mutation or action once, later, committed with the mutation. `replace` makes a newer call with the same key replace the one still waiting.
  - **`jobs.maxEventDepth`** (default 8) stops a chain of events and calls due now.
  - **Any ORM that runs SQL in a transaction** gets `databaseQueue` and `outbox`: give the database adapter a `query(client, text, params)` (`satisfies SqlDatabase`), with `logic-sdk/postgres` or `logic-sdk/sqlite`. `jobsSchema` is the tables as SQL; Drizzle users re-export `jobsTable` and `cronRunsTable`.
  - **SQLite on a disk,** with node:sqlite or bun:sqlite: `drizzleAdapter(() => drizzle("app.db"))` from `logic-sdk/drizzle/sqlite`, a connection per transaction, reads that never wait for a write.

  **Publishing.** A function is published by passing it to an adapter, one at a time, so your API surface is one file:

  ```ts
  export const router = { bookings: { confirm: toORPCProcedure(bookings.confirm) } }; // logic-sdk/orpc
  tools: { confirmBooking: toAITool(caller, bookings.confirm) };                       // logic-sdk/ai
  catch (e) { return toResponse(e); }                                                   // logic-sdk/fetch, in your own routes
  ```

  The adapters need `authorize`, by type and at runtime. `output` is optional: with it, what leaves is stripped and typed.

  **Also:**

  - `db: DrizzleDb<Db>` in `Config` gives queries a reader and mutations the transaction, minus `transaction` (a rolled-back savepoint would still send its events). Without Drizzle: `db: ReadWrite<Reader, Tx>`.
  - A function, listener or cron from another `init()` is a type error in `createRegistry`.
  - Lost races retry: `drizzleAdapter(db, { transactionAttempts })`, three tries by default.
  - An adapter's `meta` only goes where it reads it (`ForFunctions`, `ForListeners`), and descriptions are JSDoc above each export.
  - `emit` checks that payloads and scopes are plain JSON, so a `Date` fails in tests, not after a queue.
  - `onError(error, { source, job, attempt, outcome })` gets every failure no caller waits for; `waitUntil` keeps work alive after the response.

  **Upgrading from 0.4.0:**

  - `on(() => event, handler)` is `listener({ event: () => event, handler })`.
  - `description` is gone: write JSDoc above the export. For AI tools, `meta: { ai: { description } }`.
  - `expose` is gone: list what you publish with `toORPCProcedure`, `toAITool` or your own routes. `toORPCRouter`, `toAITools` and `toFetchHandler` are gone; `unauthenticated()` is in `logic-sdk`.
  - `events: dispatcher` is `jobs: { adapter }`. `registry.functions`, `.events` and `.listeners` are `registry.definitions.*`. The adapter contract is `JobsAdapter`.
  - `db` and `reader` in `Config` are `db: DrizzleDb<Db>`. `logic-sdk/drizzle` is `logic-sdk/drizzle/pg`, for Postgres (libsql no longer typechecks: overlapping mutations failed on it); SQLite has its own, `logic-sdk/drizzle/sqlite`.
  - Tests use hooks: `beforeEach(() => t.begin())`, `afterEach(() => t.rollback())`, then `t.as(scope).run(...)`. `jobs: "manual"` keeps jobs in `t.jobs.queued` and `t.jobs.scheduled` for `t.jobs.drain()`, `perform()` and `tick()`.
  - A database adapter has no `transactions` field: drop `transactions: "interactive"` from your own. `registry.modules` is gone; `registry.definitions` lists what you registered.
  - `onError`'s info is `{ source, job, attempt, outcome }`.
  - A policy must return exactly `true`: an async one denies.

### Patch Changes

- Updated dependencies [fa397fa]
  - @logic-sdk/cli@0.5.0

## 0.4.0

### Minor Changes

- 61ee14d: Functions are declared with `input`, `output` and `handler(ctx, input)`, the names app-logic libraries use (Convex, oRPC, TanStack Start), instead of the AI SDK's `inputSchema`, `outputSchema` and `execute(input, ctx)`. `ctx` comes first everywhere: handlers, listeners (`on(() => event, async (ctx, payload) => …)`) and `tx.stub(fn, async (ctx, input) => …)`. Events declare `payload` instead of `schema`.

  Ctx types come straight from your config: `type QueryCtx = QueryCtx<Config>`, with the scope taken from `Config`.

  A function that takes nothing leaves out `input`: its handler is `handler(ctx)` and callers write `run(fn)` instead of `run(fn, undefined)`. `toAITool` publishes such a function as a tool with an empty object schema.

  The CLI reads `handler`, finds `ctx` as its first parameter, and `show` prints `input none` for functions without input.

  Migrating: rename `inputSchema` to `input`, `outputSchema` to `output`, `execute` to `handler` and swap its two parameters; swap the parameters of listeners and stubs; rename `schema` to `payload` in `event({...})`; drop `inputSchema: z.undefined()` and the `undefined` in `run(fn, undefined)`.

### Patch Changes

- Updated dependencies [61ee14d]
  - @logic-sdk/cli@0.4.0

## 0.3.0

### Minor Changes

- fcaaf47: Config, and per-call options on `run`. Breaking:

  - New `ctx.config`: declare its shape in `init<Config>()` (`config: { orders: { maxItems: number } }`), fill it at the entry with `createRegistry({ config })`, and read it in queries, mutations, actions and listeners. Plain data only, copied and frozen. Tests override any part of it: `createTestRegistry(registry, { config: { orders: { maxItems: 1 } } })`.
  - `run(fn, input, { scope, signal })` holds what's specific to one call. To act as someone else: `ctx.run(fn, input, { scope: { actor: system } })`.
  - Removed: `ctx.with(...)` and `caller.with(...)` (use `run`'s third argument), and the second argument of `registry.as(scope, options)`: it takes only the scope.
  - `ctx.signal` exists only on actions. A signal is checked before the call you pass it to, never between steps.
  - Adapters pass their signal on: the fetch handler uses `request.signal`, oRPC its `signal`, AI tools their `abortSignal`. `callerOptions` in `toFetchHandler` is gone.
  - CLI: new `env-in-module` rule (module code reading `process.env`, `import.meta.env`, `Bun.env` or Cloudflare's `env`, directly or through app files it imports). `show` lists the config keys a function reads and which scope keys a run changes (`config` and `scopeChanges` in `--json`).
  - Repository moved to github.com/fprl/logic-sdk.

### Patch Changes

- Updated dependencies [fcaaf47]
  - @logic-sdk/cli@0.3.0

## 0.2.0

### Minor Changes

- 713918a: Authorization, errors and agent tools, reworked. Breaking:

  - `init<Config>()` is a single call. Policies are plain sync functions you import: `authorize: member`.
  - `expose: "staff"` becomes `authorize: staff` plus `expose: true`. `expose: true` requires `authorize` and `outputSchema`. Internal functions may have `authorize` too, and it runs even when your own code calls them.
  - Policies run before input validation and must return exactly `true`. A policy that returns a Promise is an error.
  - Record rules go in `execute`: load through a scoped helper, then `if (!canCancel(actor, order)) throw ctx.errors.deny()`.
  - Errors moved to `ctx.errors`: `throw ctx.errors.reject("not_pending")`.
  - `unauthenticated()` moved to `logic-sdk/fetch`.
  - Bad input on a nested `run` is a plain Error (a bug, 500), no longer a client 400.
  - `toAITools` requires a `filter` (the agent door is opt-in). New `toAITool(caller, fn)` for one function.
  - The fetch handler no longer lists functions on `GET {base}`.
  - Node 24 is supported (`engines` is now `>=24`).
  - CLI: shows `authorize` and `exposed`, lists `can*` checks, adds the `async-can` and `unused-can` rules, and closes boundary holes (path aliases, `#` imports, files outside modules, re-exports, dynamic imports).

### Patch Changes

- Updated dependencies [713918a]
  - @logic-sdk/cli@0.2.0
