# Example: bookings on Node

Six modules written with `logic-sdk`, served by Hono on Node, stored in Postgres.

| Module | Owns | Highlights |
|---|---|---|
| `properties` | `properties` | owners create; tenant-scoped reads |
| `availability` | `availability_holds` | `check` (query), `hold`/`release` (internal), `block` (owners). A Postgres exclusion constraint makes overlaps impossible |
| `pricing` | nothing | `priceStay` runs `properties.get`; minimum nights rule |
| `enquiries` | `enquiries` | a listener marks the enquiry won when bookings emits `confirmed` |
| `bookings` | `bookings` | `confirm` holds dates in the same transaction and emits `confirmed`; `checkout` is an action that charges, confirms, and refunds on failure |
| `tasks` | `tasks` | a listener creates a task and emails the guest in their locale |

```bash
bun run db          # Postgres 17 in Docker on 127.0.0.1:5440
bun run db:migrate
bun run dev         # http://localhost:3000
bun run test        # Vitest on Node; Postgres via PGlite in-process, no Docker needed
bun run logic-sdk graph  # the CLI: list, show, graph, check
bun run test:pg     # the same suite on the Docker Postgres, plus a race: 3 agents confirming overlapping dates at once
```

```bash
curl -X POST localhost:3000/api/properties.create \
  -H 'content-type: application/json' -H 'x-user: ana:owner' \
  -d '{"name":"Casa","nightlyRate":10000,"cleaningFee":0,"minNights":1}'
```

Read in this order: `src/logic.ts` → `src/registry.ts` → `src/bookings/mutations.ts` → `src/enquiries/listeners.ts` → `src/server.ts` → `test/app.test.ts`.
