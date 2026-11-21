---
"@logic-sdk/cli": patch
---

`list`, `show` and `check` know crons: `logic-sdk list --kind cron` shows each schedule, its time zone and the function it runs, and that function lists the cron as its caller.
