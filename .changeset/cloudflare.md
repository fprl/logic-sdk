---
"logic-sdk": minor
---

`logic-sdk/cloudflare`: jobs through Cloudflare Queues.

```ts
jobs: { adapter: outbox(db, { via: cloudflareQueue(env.JOBS) }) }   // durable: a row in your transaction, sent after commit
jobs: { adapter: cloudflareQueue(env.JOBS) }                        // sent after commit, lost if the Worker dies in between

export default {
  queue: (batch, env, ctx) => toQueueHandler(makeRegistry(env, ctx))(batch),
  scheduled: (_c, env, ctx) => makeRegistry(env, ctx).jobs.sweep(),
} satisfies ExportedHandler<Env, Job>;
```

- `outbox(db, { via })` hands each job to a queue instead of running it in the request. A failed send keeps the row, is reported to `onError`, and the sweep sends it again.
- `toQueueHandler(registry)` runs each message's job and acknowledges it, or retries it when the job threw, one message at a time.
- Adapters now get a `Runner` (`{ run, report }`) in `deliver` and `sweep`, so an adapter can report its own failures.
