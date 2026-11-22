---
"logic-sdk": minor
---

`onError`'s info is `{ source, job, attempt, outcome }`: `source` is the listener, cron or function that failed (was `listener`), `job` the job itself (was `delivery`, its id; `envelope` is `job.envelope`). The outbox's `delivery` column is `job`: regenerate your migrations. Jobs internals tidied after review: one helper for a scheduled call's replace key, exported for adapter authors as `replaceKeyOf(job)`; `inProcess()` is one shared instance; fewer casts; error messages and docs say "adapter" throughout and name crons and scheduled calls where they said only listeners.
