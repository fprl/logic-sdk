---
"logic-sdk": patch
---

`inProcess()` and inline tests report a job that throws as `failed`. With `attempts` left they reported `retry`, and never retried.
