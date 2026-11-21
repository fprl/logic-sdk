---
"logic-sdk": minor
---

`outbox(db)` in `logic-sdk/drizzle`: durable events on Postgres. Each delivery is a row written in the mutation's transaction, run after commit by the same request, and deleted when its listener is done. A listener's `attempts` decide its tries, with backoff between them (`e^attempt` seconds); `delay`ed jobs wait as rows until due. A crash is a lease running out, after which `registry.jobs.sweep()` (from a cron or an interval) takes over; a last try that never finished is failed without running again. `createRegistry` throws if the outbox isn't given the same database as `database`. Rules saying no are failed at once; failed rows stay for you to query, and `registry.jobs.retry(id)` puts one back. Re-export `outboxTable` from your schema so drizzle-kit adds it to your migrations. `drizzle-orm` (1.0) is now an optional peer dependency.
