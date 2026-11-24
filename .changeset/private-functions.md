---
"logic-sdk": patch
---

A function its module's index doesn't export is private: `ctx.run` runs it as part of the module that runs it (`files.(private)` in `wrap`, or `files.<id>` when it sets `id`), so an action can write through a mutation nothing outside the module can call. Anything that finds code by name refuses it: `ctx.schedule`, crons, `registry.as(scope).run`, adapters and tests. The bookings example's `checkout` runs `amountDue` and `confirmPaid` this way.
