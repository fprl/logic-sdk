---
"logic-sdk": minor
---

`logic-sdk/cloudflare`: jobs through Cloudflare Queues.

```ts
jobs: { adapter: outbox(database, cloudflareQueue(env.JOBS)), scope: { store, load } } // durable: a row in your transaction, sent after commit
jobs: { adapter: cloudflareQueue(env.JOBS), scope: { store, load } }             // sent after commit, lost if the Worker dies in between

export default {
  async queue(batch, env, ctx) {
    await handleQueue(makeRegistry(env, ctx), batch);
  },
  async scheduled(_controller, env, ctx) {
    await makeRegistry(env, ctx).jobs.sweep();
  },
} satisfies ExportedHandler<Env, Job>;
```

- `outbox(database, queue)` hands a commit's jobs to a queue in one send instead of running them in the request. A failed send keeps the rows, is reported to `onError`, and the sweep sends them again. A job that fails for good in the consumer comes back as a `failed` row.
- `handleQueue(registry, batch)` runs each message's job and acknowledges it, or retries it with a backoff while the listener has `attempts` left, one message at a time.
- Sends stay under Cloudflare's limits (100 messages, 256,000 bytes per send, 128,000 per message); a bigger job fails with its size. A listener's `delay` goes out as `delaySeconds`; alone, over 24 hours is refused at `createRegistry`.
- Adapters now get a `Runner` (`{ run, report }`) in `deliver` and `sweep`, so an adapter can report its own failures.
