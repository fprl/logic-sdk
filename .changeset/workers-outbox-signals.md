---
"logic-sdk": patch
---

Workers on Node, one path behind the outbox, and no pg-boss.

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
