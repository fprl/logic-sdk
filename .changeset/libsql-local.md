---
"logic-sdk": patch
---

`drizzleAdapter` docs no longer recommend libsql: on a local file, overlapping mutations fail with `SQLITE_BUSY` and can leave the database locked. Use Postgres for now.
