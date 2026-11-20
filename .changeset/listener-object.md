---
"logic-sdk": minor
"@logic-sdk/cli": minor
---

`on(() => event, handler)` is now `listener({ event: () => event, description, meta?, handler(ctx, payload) })`, an object like `query`, `mutation`, `action` and `event`. `description` is required (shown by `logic-sdk list` and `show`), and `meta` now reaches `wrap` for listeners too.

Migrate:

```ts
// before
export const sendReceipt = on(() => placed, async (ctx, payload) => { … });
// after
export const sendReceipt = listener({
  event: () => placed,
  description: "Email the receipt",
  async handler(ctx, payload) { … },
});
```

Rename `on` to `listener` where you destructure `init<Config>()`.
