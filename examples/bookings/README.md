# Example: bookings

Six modules written with `logic-sdk`, served by Hono on Node, stored in Postgres.

| Module | Owns | Highlights |
|---|---|---|
| `properties` | `properties` | owners create; tenant-scoped reads |
| `availability` | `availability_holds` | `check` (query), `hold`/`release` (internal), `block` (owners). A Postgres exclusion constraint makes overlaps impossible |
| `pricing` | nothing | `priceStay` runs `properties.get`; minimum nights rule |
| `enquiries` | `enquiries` | a listener marks the enquiry won when bookings emits `confirmed` |
| `bookings` | `bookings` | `confirm` holds dates in the same transaction and emits `confirmed`; `cancel` checks a record rule (`canCancel`); `checkout` is an action that charges, confirms, and refunds on failure |
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
curl -X POST localhost:3000/rpc/properties/create \
  -H 'content-type: application/json' -H 'x-user: ana:owner' \
  -d '{"json":{"name":"Casa","nightlyRate":10000,"cleaningFee":0,"minNights":1}}'
```

## Who may call what

- **Policies** are plain functions in `src/policies.ts` (`anyone`, `member`, `staff`, `owner`, `agent`). A function opts in with `authorize: staff`; the guard narrows `ctx.scope`, so `ctx.scope.actor` is never null inside.
- **`src/rpc.ts` is the API:** the functions a client may call, as oRPC procedures (`toORPCProcedure`, which needs `authorize`). The rest are internal: other modules `run` them, nobody calls them over the wire.
- **Record rules** run in `handler`, after loading through an account-scoped helper: `if (!canCancel(ctx.scope.actor, booking)) throw ctx.errors.deny()` (`src/bookings/data.ts`). Another account's booking is a 404, not a 403.
- **`checkout` doesn't pretend to be an admin.** A guest may pay but not read or confirm bookings, so the action runs two private functions with no policy (`amountDue`, `confirmPaid` in `src/bookings/data.ts`, which the index doesn't export). Nothing else can run them, and the scope stays the guest's.

Read in this order: `src/logic.ts` → `src/policies.ts` → `src/registry.ts` → `src/bookings/mutations.ts` → `src/bookings/actions.ts` → `src/enquiries/listeners.ts` → `src/rpc.ts` → `src/server.ts` → `test/app.test.ts`.
