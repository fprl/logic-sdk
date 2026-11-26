---
"logic-sdk": patch
---

`ctx.emit` returns the event it queued: `{ id, name, payload, occurredAt }`, the same id its listeners see as `ctx.event.id`. A row you write in the same mutation (a timeline, an audit trail) can carry `event.id`, and a listener finds it by `ctx.event.id`.
