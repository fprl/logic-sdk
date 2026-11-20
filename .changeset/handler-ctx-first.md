---
"logic-sdk": minor
"@logic-sdk/cli": minor
---

Functions are declared with `input`, `output` and `handler(ctx, input)`, the names app-logic libraries use (Convex, oRPC, TanStack Start), instead of the AI SDK's `inputSchema`, `outputSchema` and `execute(input, ctx)`. `ctx` comes first everywhere: handlers, listeners (`on(() => event, async (ctx, payload) => …)`) and `tx.stub(fn, async (ctx, input) => …)`. Events declare `payload` instead of `schema`.

Ctx types come straight from your config: `type QueryCtx = QueryCtx<Config>`, with the scope taken from `Config`.

A function that takes nothing leaves out `input`: its handler is `handler(ctx)` and callers write `run(fn)` instead of `run(fn, undefined)`. `toAITool` publishes such a function as a tool with an empty object schema.

The CLI reads `handler`, finds `ctx` as its first parameter, and `show` prints `input none` for functions without input.

Migrating: rename `inputSchema` to `input`, `outputSchema` to `output`, `execute` to `handler` and swap its two parameters; swap the parameters of listeners and stubs; rename `schema` to `payload` in `event({...})`; drop `inputSchema: z.undefined()` and the `undefined` in `run(fn, undefined)`.
