---
"logic-sdk": minor
---

`outbox(db)` in `logic-sdk/drizzle`: durable events on Postgres. Each delivery is a row written in the mutation's transaction, run after commit by the same request, and deleted when its listener is done. Failures retry with backoff (`e^attempt` seconds, 10 attempts, about 3.5 hours in all); a crash is a lease running out, after which `events.sweep(registry)` (from a cron or an interval) takes over. Rules saying no are failed at once; failed rows stay for you to query, and `events.retry(id)` puts one back. Re-export `outboxTable` from your schema so drizzle-kit adds it to your migrations. `drizzle-orm` (1.0) is now an optional peer dependency.
