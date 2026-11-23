---
"logic-sdk": minor
---

`cron({ run })` takes a thunk, like a listener's `event`: `cron({ schedule, run: () => reports.sendWeekly, scope })`. It's read when the registry is built, so no definer reads an import while files load, and import cycles between a module's files are harmless at runtime. Breaking: `run: fn` becomes `run: () => fn`.
