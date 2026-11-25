---
"logic-sdk": minor
---

A mutation whose nested mutation failed and was caught now fails its commit with its own error. The error prints the path down to the failure (`a → b → c`), says to run the calls from an action so each commits on its own, and keeps the failure as `cause`. It used to rethrow the caught failure as is. Jobs retry it as they would its cause, so a swallowed `reject` still fails at once.

A transaction doomed by a lost race (a deadlock, a serialization failure) is now rerun even when a caller caught the failure and went on. Before, Postgres failed the next statement with `25P02`, which isn't retryable, so the race was never retried.

The transactions docs and the skill show per-row work (a cron over every account) as an action.
