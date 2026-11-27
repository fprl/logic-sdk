---
"logic-sdk": patch
---

`work()` in the web process takes the request's jobs, queues, and a `failed` hook on listeners and crons.

```ts
// server.ts on Node or Bun: no waitUntil. Requests answer after commit, and the loop starts their jobs at once
const stop = work(registry, { concurrency: 5 });

// queues: declared once, named on the job, taken in a worker's order
createRegistry({ modules, database, jobs: { adapter: databaseQueue(), queues: ["mail", "reports"], scope } });
listener({ event: () => orders.placed, queue: "mail", async handler(ctx, order) { ... } });
work(registry, { queues: ["mail", "default"] });

// failed: once the last try failed, with the handler's ctx, the payload and the error
listener({ event: () => orders.placed, attempts: 5, async handler(ctx, order) { ... }, async failed(ctx, { orderId }, error) { await ctx.run(orders.flagReceipt, { orderId }); } });
```

- **`work(registry)` in the web process takes the jobs its requests commit:** the request answers right after commit and wakes the loop, which claims them at once instead of waiting `pollEvery`. Drop `waitUntil: () => {}` on Node if you had it. `databaseQueue({ runIn: "worker" })` is now only for workers in other processes.
- **Queues:** `jobs.queues` declares the names besides `"default"`; `queue` on a listener, a cron or `ctx.schedule` puts the job there; `work(registry, { queues })` and `registry.jobs.sweep({ queues })` take them in order, first queue first. An undeclared name is refused at `createRegistry`, at the call, or when `work()` starts. On the jobs table the queue is part of the job: no migration. `cloudflareQueue({ default: env.JOBS, mail: env.MAIL })` takes a binding per queue.
- **`failed` on listeners and crons** runs once the job is `failed`, at most once, with the handler's ctx (and the listener's payload) and the error. A throw is reported to `onError` as `"<id> (failed)"`. Not for a stale payload, a moved listener or a `null` `scope.load`.
- Adapter contract: `connect` gets `{ sql, workers }` (`workers.takes(job)`, `workers.wake(count)`); `queues: true | names` is a capability; `sweep(runner, { limit, queues })`; the table's `claimDue` takes `(receipt, lease, grace, queue)`. New: `registry.jobs.attach({ wake, queues })` for hosts.
- The docs no longer compare with other stacks; that lives in DESIGN.md and RESEARCH.md.
