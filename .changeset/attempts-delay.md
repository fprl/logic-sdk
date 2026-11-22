---
"logic-sdk": minor
---

Listeners take `attempts` and `delay`, and tests use hooks.

```ts
export const sendReceipt = listener({
  event: () => orders.placed,
  attempts: 5, // tries in total; default 1, like Rails and Laravel
  delay: 60,   // seconds after the event
  async handler(ctx, { orderId }) { ... },
});
```

- **`attempts`** (default 1) are enforced in `registry.jobs.run`: out of tries, a job is `failed`, and a job claimed after its last try never finished is `failed` without running again. `inProcess()` ignores `attempts` and `delay`, like Laravel's sync queue.
- **`onError` gets `outcome`** (`"retry"`, `"failed"` or `"discarded"`) for a listener's failures.
- **Adapters** get optional `check({ listeners, database })`, run at `createRegistry`, and `fail(job, error)`, called when a job a queue consumer ran fails for good. Jobs carry `runAt` when their listener has a `delay`. `run` takes a `fail` callback in its options, so an adapter keeps a failed job with its error.
- **A job this code can't run** (its listener was renamed or removed, or an unknown kind) uses its attempts, like a missing class in Laravel, so a rolling deploy's new process can run it. Out of attempts it's kept: `registry.jobs.retry(id)` runs it once the code is back. A throw from `jobs.scope.load` counts as a try, like a throw from the listener.
- **`databaseQueue` claims a commit's jobs after commit,** each just before it runs. A process that dies in between leaves them unclaimed, so the sweep's claim is their first try, not a lost one.

**Breaking, tests:** `t.transaction(async (tx) => ...)` is replaced by hooks, and `listeners: false` by `jobs: "manual"`:

```ts
const t = createTestRegistry(registry, { services: { mailer } });
beforeEach(() => t.begin());
afterEach(() => t.rollback());

test("...", async () => {
  await t.as(agent).run(bookings.confirm, { bookingId }); // was tx.as(...)
  expect(t.events).toHaveLength(1);                         // t.db, t.stub, t.registry too
});
```

- `jobs: "manual"` keeps jobs in `t.jobs.queued`; `t.jobs.drain()` runs them and `t.jobs.perform(listener, payload, { scope })` runs one.
- A failing listener now makes `run`, `drain` and `perform` throw in tests, and `rollback` when it ran through `t.registry`, so a test can't pass over it.
- Tests never use your app's jobs adapter, and listeners finish before a call returns, even when the registry sets `waitUntil`.
