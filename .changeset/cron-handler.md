---
"logic-sdk": patch
"@logic-sdk/cli": patch
---

A cron has a handler, like a listener: `cron({ schedule, scope, async handler(ctx) { await ctx.run(fn) } })`, replacing `run: () => fn` and `input`. Name it after its work. Every `ctx.run` in it checks that function's policy against the cron's scope, and it can run its module's private functions.
- The handler gets `ctx.cron` (`id`, `scheduledAt`, `attempt`), and `ctx.scope` is typed as the scope it declares.
- `wrap` and plugins see each run as `kind: "cron"` with its `meta`.
- `t.jobs.perform(cron, { at? })` runs one cron in a test.
- pg-boss tunes a cron's queue from its `meta.pgBoss`; `work(..., { crons })` is gone.
- The CLI shows what a cron's handler runs.
