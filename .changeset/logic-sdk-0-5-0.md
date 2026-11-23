---
"logic-sdk": minor
---

Background work in your database, and publishing on purpose.

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
