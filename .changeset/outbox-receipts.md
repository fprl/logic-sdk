---
"logic-sdk": minor
---

**`databaseQueue` and `outbox` don't fail or lose jobs they shouldn't.** `jobsTable` has `receipt` and `failed_at` for it.

- A slow or dead listener no longer fails the others of the same commit: each job is claimed just before it runs.
- After `registry.jobs.retry(id)`, the runner that had lost the job can no longer finish, and delete, the new run's row: each claim has its own receipt.
- A sweep claims exactly one job at a time, whatever plan Postgres picks.
- A crash right after commit is picked up 30 seconds after the mutation, where it waited a whole lease (300 seconds).
- A failed row has `failed_at`, and `last_error` holds the stack where it held only the message.
