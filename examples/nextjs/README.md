# Example: one function, two callers (Next.js)

A staff form and an AI agent both run `bookings.confirm`, from the bookings domain in `examples/node` (imported as a workspace package, not copied):

- **A Server Action** (`src/app/actions.ts`, `confirmFromForm`) calls `caller.run(bookings.confirm, ...)`.
- **An agent** (`askAgent`) gets the same functions through `toAITools(registry, caller)` and runs on Claude Opus 5.5 through the AI SDK.

Same policy, same transaction, same events after commit. The agent can't charge cards: `filter` keeps `bookings.checkout` out of its tools.

```bash
cd ../node && bun run db && bun run db:migrate   # Postgres in Docker on 127.0.0.1:5440
cd ../nextjs
ANTHROPIC_API_KEY=... bun run dev                # http://localhost:3100
```

Without `ANTHROPIC_API_KEY`, the Server Action works and the agent says it needs the key.
