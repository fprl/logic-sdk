---
"logic-sdk": patch
---

Skill: with `jobs.scope`, `store` and `load` must keep the system scope, since what a cron emits or schedules is stored like anything else.
