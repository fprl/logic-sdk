---
"@logic-sdk/cli": minor
---

Two new `check` errors, for module code and the app files it imports: `nested-transaction`, a `.transaction()` call (in a mutation it's a savepoint whose events would escape a rollback), and `db-client-in-module`, a database client created with `drizzle(...)` (writes through it are outside the mutation's transaction).
