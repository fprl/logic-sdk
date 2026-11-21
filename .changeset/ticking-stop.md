---
"logic-sdk": minor
---

`startTicking`: `stop()` returns a promise that resolves once the running tick and sweep finish, for a graceful shutdown. With ten ticks still running (the database is unreachable), the next minute is skipped and reported to `onError` instead of piling up and running a backlog of stale minutes later.
