---
"logic-sdk": minor
---

`logic-sdk/pg-boss`: jobs in pg-boss 12, inserted in your mutation's transaction, so a rollback leaves none. No outbox, no sweep.

```ts
const boss = new PgBoss(process.env.DATABASE_URL!);
boss.on("error", console.error);
export const registry = createRegistry({ modules, database: drizzleAdapter(db), jobs: { adapter: pgBoss(boss), scope: { store, load } } });

await boss.start();          // every process that enqueues or works
await work(registry, boss);  // the worker: queues, workers and the cron tick
await boss.stop();           // stops all of it
```

- **A queue per listener and per cron,** named by its id; scheduled calls share `logic-sdk.calls`. `work()` creates them and ticks your crons every minute; a cron's minute is one pg-boss id everywhere, so several workers run it once.
- **Tries are the listener's `attempts`,** stamped as `retryLimit` with pg-boss's backoff on. Failed for good is pg-boss's `deadletter` (no more retries), with the error as its `output`. `registry.jobs.retry(id)` gives a failed job a fresh set of attempts.
- **`ctx.schedule` with `replace`** deletes the waiting call in your transaction and inserts the new one under its own id; a call that started isn't touched.
- **Tuning in `meta`:** `init<{ meta: PgBossMeta & AppMeta }>()`, then `meta: { pgBoss: { queue: { expireInSeconds: 120 }, worker: { localConcurrency: 5 } } }`.
- `pgBossId(id)` turns a job id into pg-boss's (a UUID v5).
