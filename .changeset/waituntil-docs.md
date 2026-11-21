---
"logic-sdk": patch
---

`waitUntil` docs: answering before listeners finish on a long-lived server is only safe with the outbox. With `inProcess()`, work still running at a restart is lost.
