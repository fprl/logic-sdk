---
"logic-sdk": minor
---

Jobs carry their tries, and calls due now count toward `maxEventDepth`.

```ts
ctx.schedule(payments.capture, { bookingId }, { delay: 60, attempts: 3 });
```

- **`attempts` is stamped on every job when it's queued** (`job.attempts`), like Laravel and Oban, instead of read from the code when it runs. A deploy that changes a listener's or cron's `attempts` applies to jobs queued after it. Adapters that need the limit at send time (pg-boss's `retryLimit`) read it from the job.
- **`ctx.schedule(fn, input, { at | delay, attempts })`:** a scheduled call can get more than one try. Default 1.
- **A call due now is a hop in the event chain** (`CallJob.depth`): a function that schedules itself with no delay, or an emit and schedule loop, stops at `maxEventDepth` and is reported. A call that waits starts a new chain.
