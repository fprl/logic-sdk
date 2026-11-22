# Example: a shop on three hosts

One shop, written once, running on Node, Cloudflare Workers and Next.js. Two modules:

- **catalog:** `list` is open to anyone. `reserve` and `release` are internal: only orders runs them.
- **orders:** `place`, `cancel`, `ship` and `mine`. A `placed` event emails a receipt after commit.

What to look at:

- **Prices come from the catalog, never from the client.** `place` runs `catalog.reserve`, which takes stock and returns prices in the same transaction. One item short and the whole order rolls back, stock included.
- **A rule, written once.** `canCancel` (customers until it ships, staff any time) guards `cancel`, and `mine` returns it as `can.cancel` so the UI shows the button only when it would work.
- **Settings from `ctx.config`.** `place` reads `ctx.config.orders.maxItems`, the receipt reads `ctx.config.app.url`. Each host fills them from its own env with `settingsFrom(...)`; modules never read env (`logic-sdk check` fails if they do).
- **Someone else's order doesn't exist for you.** Loads go through `findOrder`, scoped to the customer (staff see all), so another customer's id is a 404.
- **The receipt is a job, and it isn't lost.** On Node and Next.js the database is the queue (`databaseQueue`). On Workers it goes through Cloudflare Queues, behind an `outbox`. The listener is the same on all three: three attempts, and an idempotency key because a job can run twice.
- **Two cancels at once, one wins.** `setStatus` only moves an order from the status it was read in; the loser gets `orders.changed` and rolls back, so stock is released once.

The files:

```txt
src/
  logic.ts       types and definers
  policies.ts    anyone, signedIn, staff
  catalog/       products: list, reserve, release
  orders/        orders: place, cancel, ship, mine, the receipt
  registry.ts    createShop(): the registry. settingsFrom(): env in, config out
  http.ts        the JSON API on Hono, shared by Node and Workers
  node.ts        host 1: Node or Bun, self-hosted. One pool, jobs in Postgres, startTicking for crons and sweeps
  worker.ts      host 2: Cloudflare Workers. Hyperdrive per request, jobs in Queues behind an outbox, a Cron Trigger
  app/           host 3: Next.js, on Vercel or anywhere. Server Actions and an AI assistant, jobs in Postgres, /tick
```

In your app there's one host and this is just `src/`. Three hosts share one folder here only to show the modules don't change.

```bash
bun run db && bun run db:migrate   # Postgres 17 in Docker on 127.0.0.1:5442
bun run dev                        # Node on http://localhost:3000
bun run dev:worker                 # Workers on http://localhost:8787
ANTHROPIC_API_KEY=... bun run dev:next   # Next.js on http://localhost:3200
bun run test                       # PGlite in-process, plus the Worker inside workerd: no Docker needed
bun run check                      # logic-sdk check: boundaries, rules, env
```

```bash
curl localhost:3000/products
curl -X POST localhost:3000/orders -H 'content-type: application/json' -H 'x-user: ana' -d '{"items":[{"sku":"mug","quantity":2}]}'
curl localhost:3000/orders -H 'x-user: ana'
curl -X POST localhost:3000/orders/<id>/ship -H 'x-user: sam:staff'
```

On Vercel, set `CRON_SECRET`: `vercel.json` calls `/tick` every minute (every 15 on Hobby: change the schedule there). None of the three has been tested deployed.

Without `ANTHROPIC_API_KEY`, the Next.js page works and the assistant asks for the key.
