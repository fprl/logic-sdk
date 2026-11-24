---
"@logic-sdk/cli": patch
---

`show` says when a function declares an `input` or `output` that JSON Schema can't express (a `Date`, a transform), instead of "not declared" or "unknown". `--json` adds `declaresOutput`.
