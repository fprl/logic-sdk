---
"logic-sdk": minor
"@logic-sdk/cli": patch
---

`ctx.run(fn, input, { scope })` takes the whole scope and no longer merges it over the caller's: write `{ scope: { ...ctx.scope, locale: "es" } }`. A partial scope could type-check and still build one that's none of your variants, passing a policy without the fields it promises. The CLI skips a spread of the caller's own scope, so `(scope: locale)` still names what changed.
