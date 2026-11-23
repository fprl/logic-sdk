---
"logic-sdk": minor
---

The last API changes before 0.5.0.

- A function, listener or cron defined with another `init()` is a type error in `createRegistry`. It used to run with this registry's scope. Events can still be shared.
- A Postgres mutation's `ctx.db` has no `transaction` to call: a savepoint that rolled back still sent the events emitted inside it. (SQLite's never had it.) Helpers typed with Drizzle's classes still take it.
- `Dispatcher` is now `JobsAdapter`, and `DeliveryOutcome` is `JobOutcome`. `onError`'s `source` for the adapter's own failures is `"(jobs adapter)"`, and for an event chain that's too deep, the event's name.
- No longer exported: `queueName` and `CALLS_QUEUE` from `logic-sdk/pg-boss`, `internal` and `Overrides` from `logic-sdk`.
- `transactionAttempts` under 1 throws at `createRegistry`, like listeners' `attempts`.
