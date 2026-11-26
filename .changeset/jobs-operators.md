---
"logic-sdk": patch
---

Operators can list failed jobs, delete one and run a cron now, and `replace` can't be mistyped anymore.

- **`registry.jobs.failed({ source, scope, limit, cursor })`** lists failed jobs, newest first, a page at a time, with `id`, `kind`, `source`, `scope`, `error` and `failedAt`. `scope` matches what `jobs.scope.store` saved, nested fields too: `failed({ source: "emails.send", scope: { organizationId } })`. `databaseQueue` and `outbox` list them; with pg-boss, use `boss.findJobs`.
- **`registry.jobs.forget(id)`** deletes a failed job, like Laravel's `queue:forget`. A waiting or running job is never touched.
- **`registry.jobs.invoke(cron, { at? })`** runs a cron now, through your jobs adapter like a tick, under its own id, so the real tick for that minute still runs. It takes the cron or its id (`"orders.sendDigest"`), and `at` redoes a missed minute.
- **`replace: true`** replaces a waiting call to the same function with the same input. It took a free string key, where a typo silently left two calls.
- **`ctx.schedule` returns nothing.** Nothing accepted the id it returned, and there's still no cancel: the function checks your row when it runs.

Migrating:

- `replace: someKey` becomes `replace: true`, with what the key held in the input: `ctx.schedule(remind, { bookingId }, { at, replace: true })`. A key passed anyway throws. Calls already waiting under an old key aren't replaced once; the next ones are.
- Drop anything that kept `ctx.schedule`'s return value.
