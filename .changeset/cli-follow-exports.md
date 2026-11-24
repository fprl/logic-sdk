---
"@logic-sdk/cli": patch
---

`show` and `graph` find a module's code the way your app does: from the file the registry imports, through `export *`, `export { a as b }` and imports. Any layout works, `orders.ts` beside an `orders/` folder included, and a renamed export shows under its exported name. They also show `ctx.schedule(...)`: `schedules files.purge` on the mutation, and the mutation under the scheduled function's `called by`.
