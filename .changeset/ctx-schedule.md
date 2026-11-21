---
"logic-sdk": minor
---

`ctx.schedule(fn, input, { at } | { delay })`: run a mutation or action once, later, from a mutation, committed with it.

```ts
ctx.schedule(guests.remind, { bookingId }, { at: dayBefore(booking.checkIn) });
ctx.schedule(holds.expire, { bookingId }, { delay: 15 * 60 }); // seconds
```

- It runs as the scheduling mutation's scope (through `jobs.scope`), one try, and returns its job id. No cancel: the function checks its reason still holds when it runs.
- Adapters declare `holds: true | { max }`: the outbox holds jobs as long as needed, `cloudflareQueue` up to 24 hours. **`inProcess()` now refuses** a listener with a `delay` at `createRegistry`, and `ctx.schedule` throws on it, rather than run them early.
- Tests: scheduled calls wait in `t.jobs.scheduled`, delayed listener jobs in `t.jobs.queued` (in both modes), and `t.jobs.drain({ until })` runs what's due by then, each at the time it was due. `drain()` now runs only what's due at the test's `now`. The test registry holds what your app's adapter holds, so a missing outbox fails in tests too.
- `Job` gains `CallJob`; `FailureInfo.listener` names the function when a scheduled call fails.
