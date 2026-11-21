---
"logic-sdk": minor
---

Crons: run a function on a schedule, declared in code.

```ts
export const morningDigest = cron({
  schedule: "0 8 * * 1-5",
  timezone: "Europe/Madrid", // optional, default UTC
  run: sendDigest,           // any query, mutation or action
  scope: system,             // who it runs as
});
```

- **`registry.jobs.tick(at?)`** runs the crons due in that minute, each as a job (`<cron id>@<minute>`) through your jobs adapter, with `attempts` like a listener. Call it from a timer on Node; on Cloudflare, `handleScheduled(registry, controller)` from `logic-sdk/cloudflare` ticks and sweeps. One platform trigger per cron and one every minute both work.
- **With `outbox(db)`, each minute runs once** across servers and redelivered triggers. Re-export `cronRunsTable` from `logic-sdk/drizzle` next to `outboxTable`.
- **Five-field schedules** (lists, ranges, steps, names), matched on the wall clock of `timezone`. Seconds, `@daily` aliases and `L`/`W`/`#` are refused at startup.
- **Tests:** `t.jobs.tick(at)` runs what's due at that minute and throws a failure.
- `Job` is now `Delivery | CronJob`, `registry.definitions.crons` lists them, and `FailureInfo.listener` names the cron when one fails.
