---
"logic-sdk": minor
---

**Breaking:** how often a mutation is retried after a deadlock or serialization failure is a database setting. `createRegistry({ retry: { attempts: 5 } })` is now `database: drizzleAdapter(db, { transactionAttempts: 5 })`, or `transactionAttempts` on your own adapter. The default is now 1, no retry, like Laravel's `DB::transaction`: it was 3. Pass `{ transactionAttempts: 3 }` to keep the old behavior.
