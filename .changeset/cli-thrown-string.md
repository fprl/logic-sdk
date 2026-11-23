---
"@logic-sdk/cli": patch
---

An app whose top-level code throws something that isn't an `Error` gets the `app-load-failed` diagnostic and exit code 1, instead of a raw `TypeError`.
