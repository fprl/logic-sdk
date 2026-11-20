---
"logic-sdk": patch
---

Leaner runtime checks. `createRegistry` still refuses an `expose: true` function without `authorize` or `output`, naming it. The checks that only repeated type errors are gone: an async policy is now simply denied (a policy must return exactly `true`). Config and event payloads share one plain-data check, so their errors read the same: "config isn't plain data at app.launch: a Date".
