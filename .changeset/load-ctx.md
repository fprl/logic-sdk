---
"logic-sdk": patch
---

`jobs.scope.load(ctx, saved)`: ctx first, like every function, with `ctx.db` and `ctx.config`.

```ts
// before: load read through your app's global db, outside a test's transaction
scope: { store: (s) => ({ userId: s.user?.id, orgId: s.orgId }), load: (saved) => scopeFor(db, saved) }
// after
scope: { store: (s) => ({ userId: s.user?.id, orgId: s.orgId }), load: (ctx, saved) => scopeFor(ctx.db, saved) }
```

- **`ctx.db` is the database your queries read,** typed the same, and in `createTestRegistry` it's the test's transaction. A job for rows a test wrote (an organization, a member) used to be discarded because `load` couldn't see them, and the test passed without the listener running.
- **Migrating:** add a first parameter to `load`, and read through `ctx.db`. `load: (saved) => saved` becomes `load: (_ctx, saved) => saved`.
