# Example: links on Cloudflare Workers

A link shortener on Hono, with two modules: `links` emits `visited` when someone follows a link, and `stats` counts it in a listener that runs after the redirect is sent (`ctx.waitUntil`). Every new link is also archived to R2.

- **One caller per request.** A Hono middleware builds the registry with this request's database and bindings, binds who is calling, and puts the caller in `c.var.caller`. Routes just `run`.
- **Errors map to statuses in one `switch`** in `app.onError`.
- **Bindings are services.** The R2 bucket goes straight into `services`, and a listener saves each new link with `services.archive.put(...)`.
- **Policies are plain functions.** `anyone` and `signedIn` live in `src/logic.ts`; functions say `authorize: signedIn`, and the guard narrows `ctx.scope.user` to a string.
- **Two files besides the modules:** `src/logic.ts` (types, policies, definers) and `src/index.ts` (the Worker: registry, caller, routes, errors).
- **Postgres through Hyperdrive**, one client per request.

```bash
bun run db && bun run db:migrate   # Postgres 17 in Docker on 127.0.0.1:5440
bun run dev                        # wrangler dev; Hyperdrive uses localConnectionString, R2 runs locally
bun run test                       # Vitest inside workerd: real R2 binding, Hyperdrive → in-process PGlite
bun run deploy                     # after `wrangler hyperdrive create` and setting the id in wrangler.jsonc
```

```bash
curl -X POST localhost:8787/links -H 'content-type: application/json' -H 'x-user: ana' -d '{"url":"https://bun.sh","slug":"bun"}'
curl -i localhost:8787/bun
curl localhost:8787/links/bun/stats -H 'x-user: ana'
```
