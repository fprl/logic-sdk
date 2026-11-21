---
"logic-sdk": minor
---

The transport option is `jobs`, and what you call on it lives on `registry.jobs`:

```ts
const registry = createRegistry({ modules, database: drizzleAdapter(db), jobs: outbox(db) }); // default inProcess()
await registry.jobs.sweep();                                          // a cron or an interval
await registry.jobs.retry(id);                                        // a failed job back in line
await registry.jobs.run(message.body, { attempt: message.attempts }); // a queue consumer
```

- `events` (the option) is now `jobs`, and `registry.deliver` is now `registry.jobs.run`.
- `registry.jobs.sweep()` runs what the transport has due, so a serverless factory only returns the registry: `scheduled: (_c, env, ctx) => ctx.waitUntil(makeRegistry(env, ctx).jobs.sweep())`. Transports that store nothing resolve `{ done: 0, failed: 0, retrying: 0 }`.
- `registry.jobs.retry(id)` only revives failed jobs and returns whether it did; it throws on `inProcess()`, which stores none. The outbox's `retry` used to reset any row, so it could run a pending one twice at once.
- The transport contract (`Dispatcher`) gets optional `sweep(run, options)` and `retry(id)`.
- `registry.functions`, `registry.events` and `registry.listeners` are now `registry.definitions.functions`, `.events` and `.listeners`.
- `Job` names the unit `registry.jobs` works on (a `Delivery` today).
