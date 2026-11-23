---
"logic-sdk": minor
"@logic-sdk/cli": minor
---

Listeners take `when`: an event gets a job for that listener only when it returns true.

```ts
export const flagFraud = listener({
  event: () => orders.placed,
  when: (order) => order.total > 5000,
  async handler(ctx, order) { ... },
});
```

Checked at commit, with the payload the handler gets (parsed), and with every adapter: false, and nothing is stored, run or counted. A throw fails the mutation. `t.jobs.perform` skips it. `logic-sdk show` says when a listener has one.
