# logic-sdk

## 0.7.4

### Patch Changes

- f4ee001: `jobs.scope.load(ctx, saved)`: ctx first, like every function, with `ctx.db` and `ctx.config`.

  ```ts
  // before: load read through your app's global db, outside a test's transaction
  scope: { store: (s) => ({ userId: s.user?.id, orgId: s.orgId }), load: (saved) => scopeFor(db, saved) }
  // after
  scope: { store: (s) => ({ userId: s.user?.id, orgId: s.orgId }), load: (ctx, saved) => scopeFor(ctx.db, saved) }
  ```

  - **`ctx.db` is the database your queries read,** typed the same, and in `createTestRegistry` it's the test's transaction. A job for rows a test wrote (an organization, a member) used to be discarded because `load` couldn't see them, and the test passed without the listener running.
  - **Migrating:** add a first parameter to `load`, and read through `ctx.db`. `load: (saved) => saved` becomes `load: (_ctx, saved) => saved`.

- 2cf0627: `work()`'s option docs say that a commit in this process wakes a sleeping slot, and no longer compare with other libraries.
- @logic-sdk/cli@0.6.6

## 0.7.3

### Patch Changes

- 77d9ecd: Listeners get `key`, `unique` and `timeout`, with the meaning Laravel gives them on SQS.

  ```ts
  listener({
    event: () => messages.received,
    key: (m) => m.conversationId, // one job per conversation at a time, in order
    timeout: 30,                  // a try past 30 s is stopped: ctx.signal aborts, and it counts as failed
    attempts: 3,
    handler: async (ctx, m) => { … },
  });

  listener({
    event: () => products.changed,
    unique: (p) => p.productId,   // while one waits, later ones are dropped: read current state in the handler
    delay: 30,
    handler: async (ctx, { productId }) => { … },
  });
  ```

  - **`key`**: jobs with the same key run one at a time, in the order their events were emitted (SQS FIFO message groups). Waiting spends no attempt, a retry holds the key, a failed job frees it. On `inProcess()`, `databaseQueue()` and `outbox(queue)`, on every database: behind an outbox the queue gets one signal per key, and `handleQueue` runs the key's next jobs from the table, in order. Refused at `createRegistry` by `cloudflareQueue` alone.
  - **`unique`**: while a job with the same value hasn't started, later ones are dropped (Laravel's `ShouldBeUniqueUntilProcessing`). It drops events, so the handler must read current state. On `databaseQueue()` and the outbox; `cloudflareQueue` alone refuses it.
  - **`timeout`**: a try past it is stopped and counts as failed. `ctx.signal` aborts (listeners get one now) and no new `ctx.run` starts.
  - **Fix:** `outbox(queue)` refuses a queue that writes in your transaction itself (one with `enqueue`): its jobs were handed to an empty `deliver` and lost. Use such a queue on its own.
  - Adapters declare `orders: true` when they run a key's jobs in order. `storedReplaceKey` is now `storedUniqueKey`, and also returns a delivery's `unique`.

  Migrating the jobs table (Drizzle: re-run drizzle-kit generate):

  ```sql
  ALTER TABLE logic_jobs RENAME COLUMN replace_key TO unique_key;
  ALTER INDEX logic_jobs_replace RENAME TO logic_jobs_unique;
  ALTER TABLE logic_jobs ADD COLUMN order_key text, ADD COLUMN seq bigserial NOT NULL;
  CREATE INDEX logic_jobs_order ON logic_jobs (order_key, seq) WHERE status = 'pending';
  ```

  Adding `seq` rewrites the table under a lock: run it when the jobs table is quiet. drizzle-kit asks whether `unique_key` is a rename of `replace_key`: it is (a drop would lose waiting `replace` keys).

  SQLite: rename the column, then `ALTER TABLE logic_jobs ADD COLUMN order_key text;` and `CREATE INDEX logic_jobs_order ON logic_jobs (order_key) WHERE status = 'pending';` (it orders by `rowid`; drop and recreate `logic_jobs_unique` under its new name).

- 77d9ecd: `work()` in the web process takes the request's jobs, queues, and a `failed` hook on listeners and crons.

  ```ts
  // server.ts on Node or Bun: no waitUntil. Requests answer after commit, and the loop starts their jobs at once
  const stop = work(registry, { concurrency: 5 });

  // queues: declared once, named on the job, taken in a worker's order
  createRegistry({ modules, database, jobs: { adapter: databaseQueue(), queues: ["mail", "reports"], scope } });
  listener({ event: () => orders.placed, queue: "mail", async handler(ctx, order) { ... } });
  work(registry, { queues: ["mail", "default"] });

  // failed: once the last try failed, with the handler's ctx, the payload and the error
  listener({ event: () => orders.placed, attempts: 5, async handler(ctx, order) { ... }, async failed(ctx, { orderId }, error) { await ctx.run(orders.flagReceipt, { orderId }); } });
  ```

  - **`work(registry)` in the web process takes the jobs its requests commit:** the request answers right after commit and wakes the loop, which claims them at once instead of waiting `pollEvery`. Drop `waitUntil: () => {}` on Node if you had it. `databaseQueue({ runIn: "worker" })` is now only for workers in other processes.
  - **Queues:** `jobs.queues` declares the names besides `"default"`; `queue` on a listener, a cron or `ctx.schedule` puts the job there; `work(registry, { queues })` and `registry.jobs.sweep({ queues })` take them in order, first queue first. An undeclared name is refused at `createRegistry`, at the call, or when `work()` starts. On the jobs table the queue is part of the job: no migration. `cloudflareQueue({ default: env.JOBS, mail: env.MAIL })` takes a binding per queue.
  - **`failed` on listeners and crons** runs once the job is `failed`, at most once, with the handler's ctx (and the listener's payload) and the error. A throw is reported to `onError` as `"<id> (failed)"`. Not for a stale payload, a moved listener or a `null` `scope.load`.
  - Adapter contract: `connect` gets `{ sql, workers }` (`workers.takes(job)`, `workers.wake(count)`); `queues: true | names` is a capability; `sweep(runner, { limit, queues })`; the table's `claimDue` takes `(receipt, lease, grace, queue)`. New: `registry.jobs.attach({ wake, queues })` for hosts.
  - The docs no longer compare with other stacks; that lives in DESIGN.md and RESEARCH.md.

- 77d9ecd: Workers on Node, one path behind the outbox, and no pg-boss.

  ```ts
  // registry.ts: web requests only write the rows
  jobs: { adapter: databaseQueue({ runIn: "worker" }), scope: { store, load } },

  // worker.ts: as many processes as you like
  import { work } from "logic-sdk/node";
  const stop = work(registry, { concurrency: 5 });
  process.on("SIGTERM", async () => { await stop(); process.exit(0); });
  ```

  - **`work(registry, { concurrency, pollEvery })`** from `logic-sdk/node` replaces `startTicking`: `concurrency` slots (default 1) each claim the next due job, a free one waits `pollEvery` seconds (default 2), and your crons tick every minute, once across workers. While the database is down a slot waits longer each time, up to 30 s. Rename `startTicking(registry)` to `work(registry)`; `sweepEvery` is gone, since the slots are the sweep.
  - **`databaseQueue({ runIn: "worker" })`** leaves every job to workers in other processes: requests only write rows, and a job is available to workers as soon as it's committed. The default, `"request"`, is unchanged.
  - **Behind an outbox, every job stays a row** and the queue carries signals: one per job, one per `key`. The consumer runs the row it names and records how it went in the table, so tries, `failed()`, `retry(id)`, `key`, `unique` and `replace` behave as with `databaseQueue`. A failed try backs off as a row and gets a new message for when the backoff ends. The sweep runs what a signal didn't cover, 30 seconds past due. `outbox(queue, { maxAttempts })` is gone, and Cloudflare's `max_retries` no longer matters behind an outbox (keep `max_batch_size: 1`, so each job gets a whole invocation). **Before upgrading, let the queue drain** (backed-off retries can wait up to about 6 hours): a message sent by the old version names a row that's already gone, and is acknowledged without running.
  - **`logic-sdk/pg-boss` is removed** (`pgBoss`, `work(registry, boss)`, `meta.pgBoss`, the peer dependency). Use `databaseQueue()` with `work()` on the same Postgres.
  - **A listener with both `key` and `unique` is refused:** a key's jobs could run out of order.
  - Adapter contract: `consume(job, runner)` replaces `runKey` and `fail`; `registry.jobs.run(job, { attempt })` takes no `fail`; `connect` gets `{ sql }` only.

- @logic-sdk/cli@0.6.6

## 0.7.2

### Patch Changes

- a726b80: `ctx.emit` returns the event it queued: `{ id, name, payload, occurredAt }`, the same id its listeners see as `ctx.event.id`. A row you write in the same mutation (a timeline, an audit trail) can carry `event.id`, and a listener finds it by `ctx.event.id`.
- a726b80: Operators can list failed jobs, delete one and run a cron now, and `replace` can't be mistyped anymore.

  - **`registry.jobs.failed({ source, scope, limit, cursor })`** lists failed jobs, newest first, a page at a time, with `id`, `kind`, `source`, `scope`, `error` and `failedAt`. `scope` matches what `jobs.scope.store` saved, nested fields too: `failed({ source: "emails.send", scope: { organizationId } })`. `databaseQueue` and `outbox` list them; with pg-boss, use `boss.findJobs`.
  - **`registry.jobs.forget(id)`** deletes a failed job, like Laravel's `queue:forget`. A waiting or running job is never touched.
  - **`registry.jobs.invoke(cron, { at? })`** runs a cron now, through your jobs adapter like a tick, under its own id, so the real tick for that minute still runs. It takes the cron or its id (`"orders.sendDigest"`), and `at` redoes a missed minute.
  - **`replace: true`** replaces a waiting call to the same function with the same input. It took a free string key, where a typo silently left two calls.
  - **`ctx.schedule` returns nothing.** Nothing accepted the id it returned, and there's still no cancel: the function checks your row when it runs.

  Migrating:

  - `replace: someKey` becomes `replace: true`, with what the key held in the input: `ctx.schedule(remind, { bookingId }, { at, replace: true })`. A key passed anyway throws. Calls already waiting under an old key aren't replaced once; the next ones are.
  - Drop anything that kept `ctx.schedule`'s return value.

- a726b80: The core, adapters and hosts now follow one written rule (AGENTS.md, "Layers"), and that changed a few things.

  - **`database: { adapter, transactionAttempts }`.** The database option is an object, like `jobs`. `transactionAttempts` moved here from `drizzleAdapter(db, { transactionAttempts })`: how many tries a mutation gets decides what lands in your data, so it's the registry's.
  - **Failed jobs for a queue on its own:** `jobs: { adapter: cloudflareQueue(env.JOBS), failed: failedJobs(database) }` keeps a job out of attempts as a row, so `registry.jobs.failed()`, `retry(id)` (back to the queue) and `forget(id)` work. From `logic-sdk/postgres`, `logic-sdk/sqlite` and the Drizzle subpaths.
  - **pg-boss with any database adapter that runs SQL,** not only Drizzle: it inserts its jobs through the adapter's `query`.
  - **`ctx.schedule(fn, input, { at, scope })`** runs the call as the scope you pass, whole, as `ctx.run` takes it.
  - **`wrap`'s call has `job: { id, attempt }`** on a listener's, cron's or scheduled call's own run.
  - **`inProcess()` refuses `attempts` above 1** at `createRegistry`, as it refuses a delay. It ran each job once and ignored them.
  - **Messages name what your adapter can't do,** and the adapter by its own `name`, never another adapter.
  - **`defaultBackoff`** is exported from `logic-sdk`, for adapters that back off.
  - **`databaseQueue()`, `outbox(queue)` and `failedJobs()` take the registry's database.** Jobs are written in your mutation's transaction, so it was always the same one: passing it again only made a mismatch possible. Like Laravel's `database` driver, which uses the app's connection.
  - **Adapters declare `sql: true`** when they write with SQL in your transaction, and the core refuses a database adapter without `query` at `createRegistry`. Their `check(setup)` hook is now `connect(setup)`, and gets the database as `setup.sql`.
  - **The jobs table gains `claimed_at`,** when the running try was claimed, empty while a row waits (first, or after a backoff), like Laravel's `reserved_at` and Oban's `attempted_at`: a query can tell running from waiting.
  - **Two indexes:** `logic_jobs_failed` on `(failed_at, id)` for `registry.jobs.failed()`, and `logic_cron_runs_ran_at` for pruning old ticks.

  Migrating:

  - `databaseQueue(database)` becomes `databaseQueue()`, `outbox(database, queue)` becomes `outbox(queue)`, `failedJobs(database)` becomes `failedJobs()`.
  - Add the column and the two indexes: re-run drizzle-kit, or from `jobsSchema`: `ALTER TABLE logic_jobs ADD COLUMN claimed_at timestamptz;` (`integer` on SQLite), then `CREATE INDEX logic_jobs_failed ON logic_jobs (failed_at, id) WHERE status = 'failed'; CREATE INDEX logic_cron_runs_ran_at ON logic_cron_runs (ran_at);`
  - Your own adapter's `check(setup)` becomes `connect(setup)`.
  - `database: drizzleAdapter(db)` becomes `database: { adapter: drizzleAdapter(db) }`; `drizzleAdapter(db, { transactionAttempts: 5 })` becomes `database: { adapter: drizzleAdapter(db), transactionAttempts: 5 }`.
  - On `inProcess()`, a listener, cron or `ctx.schedule` with `attempts` above 1 now throws: set `attempts: 1`, or use an adapter that retries (`databaseQueue(database)`).
  - Your own jobs adapter can set `name` and `retries: true`; without `retries`, `attempts` above 1 are refused.
  - Removed types: `DrizzleAdapterOptions` (`drizzleAdapter` takes no options), and `query` and `transactionAttempts` on `DatabaseAdapter`: `query` is on `SqlDatabase`, which your own adapter satisfies to run the jobs table or pg-boss.
  - For adapters that replace: `storedReplaceKey(job)` is the key to store (`<fn>@<sha-256>`).

- Updated dependencies [a726b80]
  - @logic-sdk/cli@0.6.6

## 0.7.1

### Patch Changes

- d3a6c84: A cron has a handler, like a listener: `cron({ schedule, scope, async handler(ctx) { await ctx.run(fn) } })`, replacing `run: () => fn` and `input`. Name it after its work. Every `ctx.run` in it checks that function's policy against the cron's scope, and it can run its module's private functions.
  - The handler gets `ctx.cron` (`id`, `scheduledAt`, `attempt`), and `ctx.scope` is typed as the scope it declares.
  - `wrap` and plugins see each run as `kind: "cron"` with its `meta`.
  - `t.jobs.perform(cron, { at? })` runs one cron in a test.
  - pg-boss tunes a cron's queue from its `meta.pgBoss`; `work(..., { crons })` is gone.
  - The CLI shows what a cron's handler runs.
- Updated dependencies [d3a6c84]
  - @logic-sdk/cli@0.6.5

## 0.7.0

### Minor Changes

- f417377: A mutation whose nested mutation failed and was caught now fails its commit with its own error. The error prints the path down to the failure (`a → b → c`), says to run the calls from an action so each commits on its own, and keeps the failure as `cause`. It used to rethrow the caught failure as is. Jobs retry it as they would its cause, so a swallowed `reject` still fails at once.

  A transaction doomed by a lost race (a deadlock, a serialization failure) is now rerun even when a caller caught the failure and went on. Before, Postgres failed the next statement with `25P02`, which isn't retryable, so the race was never retried.

  The transactions docs and the skill show per-row work (a cron over every account) as an action.

- f417377: `ctx.run(fn, input, { scope })` takes the whole scope and no longer merges it over the caller's: write `{ scope: { ...ctx.scope, locale: "es" } }`. A partial scope could type-check and still build one that's none of your variants, passing a policy without the fields it promises. The CLI skips a spread of the caller's own scope, so `(scope: locale)` still names what changed.

### Patch Changes

- Updated dependencies [f417377]
  - @logic-sdk/cli@0.6.4

## 0.6.3

### Patch Changes

- 9cb2bff: The skill says where a private function goes: unexported in the file that runs it, or in `data.ts` when two files share it, never exported from `mutations.ts`, where `export *` would publish it.
- Updated dependencies [9cb2bff]
  - @logic-sdk/cli@0.6.3

## 0.6.2

### Patch Changes

- 5a12738: A function its module's index doesn't export is private: `ctx.run` runs it as part of the module that runs it (`files.(private)` in `wrap`, or `files.<id>` when it sets `id`), so an action can write through a mutation nothing outside the module can call. Anything that finds code by name refuses it: `ctx.schedule`, crons, `registry.as(scope).run`, adapters and tests. The bookings example's `checkout` runs `amountDue` and `confirmPaid` this way.
- Updated dependencies [5a12738]
- Updated dependencies [a38d9fc]
  - @logic-sdk/cli@0.6.2

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
