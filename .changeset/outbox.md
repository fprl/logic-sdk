---
"logic-sdk": minor
---

`databaseQueue(db)` in `logic-sdk/drizzle`: your Postgres is the queue, like Laravel's `database` driver. Each job is a row written in the mutation's transaction, run after commit by the same request, and deleted when it's done. A listener's `attempts` decide its tries, with backoff between them (`e^attempt` seconds); `delay`ed jobs wait as rows until due. A crash is a lease running out, after which `registry.jobs.sweep()` (from a cron or an interval) takes over; a last try that never finished is failed without running again. `createRegistry` throws if it isn't given the same database as `database`. Rules saying no are failed at once; failed rows stay for you to query, and `registry.jobs.retry(id)` puts one back. Re-export `jobsTable` from your schema so drizzle-kit adds `logic_jobs` to your migrations. `drizzle-orm` (1.0) is now an optional peer dependency.

`outbox(db, queue)` uses the same table in front of another queue: the row is kept only until the queue has the job.
