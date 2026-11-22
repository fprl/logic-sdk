---
"logic-sdk": minor
---

**SQLite on a disk**, with node:sqlite or bun:sqlite: mutations, queries, jobs, crons and the test registry.

```ts
import { databaseQueue, drizzleAdapter } from "logic-sdk/drizzle/sqlite";

const database = drizzleAdapter(() => drizzle("app.db"));
createRegistry({ modules, database, jobs: { adapter: databaseQueue(database), scope } });
```

You give one function that opens the file. Queries read on a connection that can't write and never wait for a mutation, each transaction gets a connection of its own, and several processes can share the file. `logic-sdk/sqlite` has `databaseQueue`, `outbox` and the tables as SQL for other ORMs.
