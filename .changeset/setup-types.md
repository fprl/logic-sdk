---
"logic-sdk": minor
---

**`db: DrizzleDb<Db>` replaces `db` and `reader` in your Config.** Queries get a reader and mutations the transaction, with nothing to remember. `reader` is gone.

```ts
// before
type Tx = DrizzleTx<Db>;
type Config = { scope: Scope; db: Tx; reader: DrizzleReader<Tx> };

// after
type Config = { scope: Scope; db: DrizzleDb<Db> };
```

Without Drizzle, write the two sides: `db: ReadWrite<MyReader, MyTx>`.

**An adapter's `meta` only goes where it reads it.** `meta: AppMeta & AIMeta & PgBossMeta` is written as before. `ai` on a listener and `pgBoss` on a query, mutation or action, which were ignored, are now type errors. Your own adapters export `ForFunctions<...>` or `ForListeners<...>`. `AIMeta["ai"]` and `PgBossMeta["pgBoss"]` no longer index.

**A clearer error without `db`:** `ctx.db` is `SetupError<"Add db to the Config you pass to init">` instead of `never`.

**Apps that emit declarations compile:** the types `init` infers are exported, so `declaration: true` no longer fails with TS2883. pg-boss's options are `PgBossTuning`.
