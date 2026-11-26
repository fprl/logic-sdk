---
"logic-sdk": patch
---

The core, adapters and hosts now follow one written rule (AGENTS.md, "Layers"), and that changed a few things.

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
