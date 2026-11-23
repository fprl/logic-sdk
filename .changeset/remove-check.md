---
"@logic-sdk/cli": minor
---

`logic-sdk check` is removed, with its rules. What the library promises holds through its types and runtime: a query can't write, a mutation has no services, an action has no transaction, and `ctx.run` stops at 64 nested calls. Import boundaries, cycles, env and clock reads are your linter's call. `list`, `show` and `graph` are unchanged.
