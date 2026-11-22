---
"logic-sdk": minor
---

`ctx.schedule(fn, input, { at | delay, replace: key })`: a newer call to the same function with the same key replaces the one still waiting, so a reminder whose booking moved runs once, at the new time. A call that already started isn't touched. Like Oban's `replace` and Laravel's `DebounceFor`.

```ts
ctx.schedule(guests.remind, { bookingId }, { at: dayBefore(booking.checkIn), replace: bookingId });
```

- **`databaseQueue` and `outbox` do it,** with `jobsTable`'s `replace_key` column and a partial unique index on rows still waiting.
- **Adapters opt in with `replaces: true`.** Without it (`inProcess()`, `cloudflareQueue` alone, which can't take back a sent message), `ctx.schedule` with `replace` throws. The test registry replaces when your app's adapter does.
