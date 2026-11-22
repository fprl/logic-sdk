---
"logic-sdk": minor
---

**A slow job is no longer marked failed, or run twice, for outliving `databaseQueue`'s lease.** A running job extends its lease every third of it, for up to 15 minutes, so `lease` (still 300 seconds) is now how soon a crash is noticed and needn't cover your slowest listener. A job longer than 15 minutes still needs a `lease` that long.
