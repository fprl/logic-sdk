---
"logic-sdk": patch
---

`fn.input` is the schema as you wrote it, so a form can derive from the function it calls: `properties.update.input.pick({ name: true })`, with no schema exported for it. It's `undefined` when the function takes no input. `Fn` gets a sixth type parameter for it, defaulting to `Schema | undefined`, and `input` is no longer optional on the type.
