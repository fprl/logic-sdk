# @logic-sdk/cli

## 0.6.0

### Minor Changes

- e7964b8: Reads a cron's function from the registry the new way (`cron({ run: () => fn })`), so it needs logic-sdk 0.6.
- e453d76: `logic-sdk check` is removed, with its rules. What the library promises holds through its types and runtime: a query can't write, a mutation has no services, an action has no transaction, and `ctx.run` stops at 64 nested calls. Import boundaries, cycles, env and clock reads are your linter's call. `list`, `show` and `graph` are unchanged.

### Patch Changes

- Updated dependencies [e7964b8]
- Updated dependencies [9946bd4]
- Updated dependencies [e453d76]
  - logic-sdk@0.6.0

## 0.5.0

### Minor Changes

- fa397fa: The CLI knows jobs, and `check` guards the transaction.

  - **Crons and listeners:** `list --kind cron` shows each schedule, its time zone and the function it runs, and that function lists the cron as its caller; `graph` draws them in text, Mermaid and JSON; `show` prints a listener's `when`.
  - **Ids:** every command shows and links definitions by their `id`, so a renamed export keeps its name.
  - **Descriptions** come from the JSDoc above each export: `list` and `show` print its first paragraph.
  - **`check` fails on `.transaction()` in module code** (`nested-transaction`: a savepoint whose events would escape a rollback) and **on a database client created there** (`db-client-in-module`: writes outside the mutation's transaction), directly or through an app file it imports. It names functions by id when they read the clock or call `fetch` in a transaction.
  - **Policies, not exposure:** `list` shows each function's policy; `--exposed` is gone with `expose`.
  - An app whose top-level code throws something that isn't an `Error` gets the `app-load-failed` diagnostic, not a raw `TypeError`.

### Patch Changes

- Updated dependencies [fa397fa]
  - logic-sdk@0.5.0

## 0.4.0

### Minor Changes

- 61ee14d: Functions are declared with `input`, `output` and `handler(ctx, input)`, the names app-logic libraries use (Convex, oRPC, TanStack Start), instead of the AI SDK's `inputSchema`, `outputSchema` and `execute(input, ctx)`. `ctx` comes first everywhere: handlers, listeners (`on(() => event, async (ctx, payload) => …)`) and `tx.stub(fn, async (ctx, input) => …)`. Events declare `payload` instead of `schema`.

  Ctx types come straight from your config: `type QueryCtx = QueryCtx<Config>`, with the scope taken from `Config`.

  A function that takes nothing leaves out `input`: its handler is `handler(ctx)` and callers write `run(fn)` instead of `run(fn, undefined)`. `toAITool` publishes such a function as a tool with an empty object schema.

  The CLI reads `handler`, finds `ctx` as its first parameter, and `show` prints `input none` for functions without input.

  Migrating: rename `inputSchema` to `input`, `outputSchema` to `output`, `execute` to `handler` and swap its two parameters; swap the parameters of listeners and stubs; rename `schema` to `payload` in `event({...})`; drop `inputSchema: z.undefined()` and the `undefined` in `run(fn, undefined)`.

### Patch Changes

- Updated dependencies [61ee14d]
  - logic-sdk@0.4.0

## 0.3.0

### Minor Changes

- fcaaf47: Config, and per-call options on `run`. Breaking:

  - New `ctx.config`: declare its shape in `init<Config>()` (`config: { orders: { maxItems: number } }`), fill it at the entry with `createRegistry({ config })`, and read it in queries, mutations, actions and listeners. Plain data only, copied and frozen. Tests override any part of it: `createTestRegistry(registry, { config: { orders: { maxItems: 1 } } })`.
  - `run(fn, input, { scope, signal })` holds what's specific to one call. To act as someone else: `ctx.run(fn, input, { scope: { actor: system } })`.
  - Removed: `ctx.with(...)` and `caller.with(...)` (use `run`'s third argument), and the second argument of `registry.as(scope, options)`: it takes only the scope.
  - `ctx.signal` exists only on actions. A signal is checked before the call you pass it to, never between steps.
  - Adapters pass their signal on: the fetch handler uses `request.signal`, oRPC its `signal`, AI tools their `abortSignal`. `callerOptions` in `toFetchHandler` is gone.
  - CLI: new `env-in-module` rule (module code reading `process.env`, `import.meta.env`, `Bun.env` or Cloudflare's `env`, directly or through app files it imports). `show` lists the config keys a function reads and which scope keys a run changes (`config` and `scopeChanges` in `--json`).
  - Repository moved to github.com/fprl/logic-sdk.

### Patch Changes

- Updated dependencies [fcaaf47]
  - logic-sdk@0.3.0

## 0.2.0

### Minor Changes

- 713918a: Authorization, errors and agent tools, reworked. Breaking:

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

### Patch Changes

- Updated dependencies [713918a]
  - logic-sdk@0.2.0
