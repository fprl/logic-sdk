---
"logic-sdk": patch
---

Docs and skill: scheduled calls and crons can run twice, mutations included, like listeners. Make them idempotent, for example with a unique key and `onConflictDoNothing()`.
