---
"logic-sdk": minor
---

**Any ORM that can run SQL in a transaction has `databaseQueue` and `outbox`,** through one `query` method on the database adapter.

```ts
import { databaseQueue } from "logic-sdk/postgres";

const database = {
  db: prisma,
  transactions: "interactive",
  transaction: (fn) => prisma.$transaction(fn),
  query: (client, text, params) => client.$queryRawUnsafe(text, ...params),
} satisfies DatabaseAdapter<PrismaClient, Prisma.TransactionClient>;

createRegistry({ modules, database, jobs: { adapter: databaseQueue(database), scope } });
```

- **Breaking:** `logic-sdk/drizzle` is `logic-sdk/drizzle/pg`.
- **Breaking:** `databaseQueue` and `outbox` take the adapter `database` got, not the Drizzle database: `const database = drizzleAdapter(db)`, then `databaseQueue(database)`.
- `jobsSchema` is the tables as SQL, for migrations without drizzle-kit.
