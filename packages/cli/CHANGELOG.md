# @logic-sdk/cli

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
