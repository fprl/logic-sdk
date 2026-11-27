---
"logic-sdk": patch
---

Listeners get `key`, `unique` and `timeout`, with the meaning Laravel gives them on SQS.

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
