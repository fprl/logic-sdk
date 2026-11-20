---
"logic-sdk": minor
---

The delivery contract for durable events. Each committed event becomes one `Delivery` per listener (`{ id, listener, envelope }`, `id` being `<event id>:<listener id>`), so a failing listener retries alone. Dispatchers get `enqueue(tx, deliveries)` and `deliver(deliveries, run)`; `inProcess()` is unchanged for you.

`registry.dispatch(envelope)` is now `registry.deliver(delivery, { attempt })`. It resolves `"done"`, or `"failed"` when retrying can't help (a domain error other than `conflict`, or a payload that no longer matches its schema), and throws when a retry might help. `onError` gets the delivery id and attempt.

`emit` checks that the payload and the scope are plain JSON, so a `Date` fails in tests instead of after a queue. Envelopes carry `depth`, so the loop limit holds across hops. Listeners get `ctx.event` as `{ id, name, payload, occurredAt, attempt }`, without the stored scope: `ctx.scope` is the one they run as.
