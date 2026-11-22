---
"logic-sdk": minor
"@logic-sdk/cli": patch
---

Background work is configured under `jobs`, and what you call on it lives on `registry.jobs`:

```ts
const registry = createRegistry({
  modules,
  database: drizzleAdapter(db),
  jobs: {
    adapter: databaseQueue(db),                       // default inProcess()
    scope: { store: (s) => ({ userId: s.userId }), load: (saved) => scopeFor(saved) },
  },
});
await registry.jobs.sweep();                                          // a cron or an interval
await registry.jobs.retry(id);                                        // a failed job back in line
await registry.jobs.run(message.body, { attempt: message.attempts }); // a queue consumer
```

- `events: dispatcher` (the option) is now `jobs: { adapter }`, and `registry.deliver` is now `registry.jobs.run`.
- `jobs.scope` sets who a job runs as at rest: `store` picks what's saved (checked as plain JSON at emit), `load` rebuilds it when the job runs. `load` returning `null` discards the job: a new `"discarded"` outcome, reported to `onError`, deleted from the jobs table and counted by `sweep`. Applied in every adapter, `inProcess()` and tests included.
- Every definer takes an optional `id`, local to its module (`listener({ id: "send" })` in `notifications` is `notifications.send`), so you can rename an export without orphaning queued jobs. Duplicates throw at `createRegistry`. The CLI shows and links definitions by these ids.
- Jobs carry `kind: "delivery"`, and their id is now `<listener id>@<event id>` (BullMQ rejects `:` in job ids).
- `registry.jobs.sweep()` runs what the adapter has due; adapters that store nothing resolve zeros. `registry.jobs.retry(id)` only revives failed jobs and returns whether it did, and throws on `inProcess()`. `databaseQueue`'s `retry` used to reset any row, so it could run a pending one twice at once.
- The adapter contract (`Dispatcher`) gets optional `sweep(run, options)` and `retry(id)`.
- `registry.functions`, `registry.events` and `registry.listeners` are now `registry.definitions.functions`, `.events` and `.listeners`.
