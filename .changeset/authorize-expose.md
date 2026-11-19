---
"logic-sdk": minor
"@logic-sdk/cli": minor
---

Authorization, errors and agent tools, reworked. Breaking:

- `init<Config>()` is a single call. Policies are plain sync functions you import: `authorize: member`.
- `expose: "staff"` becomes `authorize: staff` plus `expose: true`. `expose: true` requires `authorize` and `outputSchema`. Internal functions may have `authorize` too, and it runs even when your own code calls them.
- Policies run before input validation and must return exactly `true`. A policy that returns a Promise is an error.
- Record rules go in `execute`: load through a scoped helper, then `if (!canCancel(actor, order)) throw ctx.errors.deny()`.
- Errors moved to `ctx.errors`: `throw ctx.errors.reject("not_pending")`.
- `unauthenticated()` moved to `logic-sdk/fetch`.
- Bad input on a nested `run` is a plain Error (a bug, 500), no longer a client 400.
- `toAITools` requires a `filter` (the agent door is opt-in). New `toAITool(caller, fn)` for one function.
- The fetch handler no longer lists functions on `GET {base}`.
- Node 24 is supported (`engines` is now `>=24`).
- CLI: shows `authorize` and `exposed`, lists `can*` checks, adds the `async-can` and `unused-can` rules, and closes boundary holes (path aliases, `#` imports, files outside modules, re-exports, dynamic imports).
