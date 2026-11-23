---
"logic-sdk": patch
---

`ctx.run` nests at most 64 calls deep. Past that it throws a plain error with the last calls of the path (`… → a.ping → b.pong → a.ping`), instead of a function that runs itself, directly or through other modules, running until memory runs out. Recurse in a helper that takes `ctx`, or make each step an event or `ctx.schedule`.
