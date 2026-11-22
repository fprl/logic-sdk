---
"logic-sdk": minor
---

**Breaking:** how often a mutation is retried after a deadlock or serialization failure is a database setting. `createRegistry({ retry: { attempts: 5 } })` is now `database: drizzleAdapter(db, { transactionAttempts: 5 })`, or `transactionAttempts` on your own adapter. The default is still 3.
