---
"logic-sdk": minor
"@logic-sdk/cli": minor
---

Publishing is explicit: `expose` is gone, and a function is published by passing it to an adapter, one at a time.

```ts
// src/rpc.ts: the API surface
export const router = { bookings: { confirm: toORPCProcedure(bookings.confirm) } };
// an agent's tools
tools: { confirmBooking: toAITool(caller, bookings.confirm) };
// your own routes
catch (e) { return toResponse(e); }
```

- `toORPCProcedure(fn)` replaces `toORPCRouter(registry)`: a real oRPC procedure (`.use`, `.meta`, `.errors`) for your own router, its context typed with your `init`'s scope.
- `toAITools` and `meta.ai.tool` are gone; `toAITool(caller, fn)` stays, and `meta.ai.description` too.
- `toFetchHandler` is gone. `toResponse(error)` from `logic-sdk/fetch` maps a domain error to its status, and throws anything else again for your framework's 500. `unauthenticated()` is in `logic-sdk`.
- The adapters need `authorize`, by type and at runtime. `output` is optional: with it, what leaves is stripped and typed.
- `registry.definitions.functions[].exposed`, `ExposedFn` and `ExposedOf` are gone; `PublishableFn` is a function with `authorize`. The CLI drops `--exposed` and shows the policy.
