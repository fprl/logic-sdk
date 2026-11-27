# AGENTS.md

Working on logic-sdk itself. For how apps use it, read the skill we ship: [`packages/logic-sdk/skills/logic-sdk/SKILL.md`](packages/logic-sdk/skills/logic-sdk/SKILL.md). Humans: start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

```bash
bun install
bun run test     # build, typecheck, lint, publint/attw, then core, CLI and both examples' tests
bun run --filter web dev   # docs site
```

## Layout

- `packages/logic-sdk`: the core and subpath adapters (`ai`, `orpc`, `fetch`, `drizzle`, `cloudflare`, `node`, `testing`). `src/` is by layer:
  - `src/*.ts`, `src/drizzle/*.ts`: one entry per `exports` subpath, re-exports only.
  - `src/core/`: `registry.ts` (`init`, `createRegistry`: calls, transactions, ctx), `types.ts` (the public types, plus the brand and internal symbols), `jobs.ts` (running jobs, crons, `registry.jobs`), `in-process.ts` (`inProcess()`, the default adapter), `errors.ts`, `schedule.ts` (cron matching), `testing.ts`.
  - `src/adapters/`: `stored-jobs.ts` (the jobs table, any SQL database), `postgres.ts`, `sqlite.ts`, `drizzle-pg.ts`, `drizzle-sqlite.ts`, `cloudflare-queue.ts`.
  - `src/hosts/`: `node.ts` (`work`), `cloudflare.ts` (`handleQueue`, `handleScheduled`).
  - `src/integrations/`: `ai.ts`, `orpc.ts`, `fetch.ts`.
  - `test/` mirrors it: `core/`, `testing/`, `adapters/`, `hosts/`, `integrations/`, plus `conformance/` (`*.suite.ts`: the jobs table's and every jobs adapter's guarantees, run from `adapters/`), `support/` (shared fixtures) and `types/` (`types.check.ts`, checked by `tsc`).
  - `skills/logic-sdk/SKILL.md` ships in the tarball.
- `packages/cli`: `logic-sdk list | show | graph`. Static analysis with oxc (`src/analyze.ts`), runtime facts from loading the registry (`src/project.ts`).
- `examples/shop` (one app on Node, Workers and Next.js) and `examples/bookings` (six modules): both tested against real Postgres (PGlite in tests).
- `apps/web`: the docs site.
- `DESIGN.md`: decisions and why. `RESEARCH.md`: how other stacks do it. `ROADMAP.md`: what's next.

## Rules

- **Done means `bun run test` passes.** Change the skill, the docs and the examples in the same change as the API.
- **Every change to a published package gets a changeset** (see CONTRIBUTING.md). No hand edits to `CHANGELOG.md` or versions.
- **Decisions go in DESIGN.md with the reason and what would change it.** Claims about other libraries cite a source; inference is labelled.
- **Reference stacks, in order:** Vercel, TanStack, Convex, then Rails, Laravel, Phoenix.
- **Before designing a mechanism, check what the stacks do.** Retries, claims, scheduling, failure handling, test helpers: read how Rails, Laravel and Phoenix (Oban) do it, and the TS stacks where they have one, from their source or docs, not memory. Then say what we take from them: all of it, some, or nothing, and why. Designing first and checking after is how fixes kept needing fixes (see DESIGN.md, "Jobs").
- **A queued job's life follows one model: a lease the runner extends** (DESIGN.md, "The jobs model", which names the source of each part: SQS's visibility timeout and receipt, Laravel Cloud's and the Vercel Queues SDK's extension, Laravel's worker for retry and fail). Claim, extend, retry, fail and order don't mix in pieces from other stacks. Those are for what surrounds it: enqueue, crons, workers, names.
- **Keep the core small:** every change names its layer and passes that layer's test (below).

## Layers

Something that fits no layer, or two, is a design question before it's code. Why, and the stacks behind it: DESIGN.md, "Layers".

| Layer | What's in it | Its test |
|---|---|---|
| **Userland** | the app: its rows and their status, its scope's shape, policies, events, handlers, routes, UI | it needs to know what the app's data means |
| **Extensions** | plugins, dashboards, the CLI, and the integrations `ai`, `orpc`, `fetch` (your functions as AI tools, oRPC procedures, an HTTP handler) | it uses the public API and its own `meta.<name>`, nothing else |
| **Core** | `logic-sdk`, plus `logic-sdk/testing` (the only code allowed `INTERNAL`) | it means the same on every adapter, and correctness depends on it |
| **Adapters** | `inProcess`, `drizzle/*`, `postgres`, `sqlite`, `cloudflareQueue` | one core contract on one technology: it does what the contract says, or refuses at `createRegistry` |
| **Hosts** | `work`, `handleQueue`, `handleScheduled` | it turns one platform signal into one public call |
| **Platforms** | Postgres, SQLite and D1, Workers and Queues, Vercel, Node | capacity and operations, set in their own config, which the library never reads |

- **The core never names an adapter or a provider,** in code or in messages. It names the capability ("can't hold jobs"), and the adapter names itself.
- **Capabilities are declared** (`holds`, `replaces`, `retry`…) and the core refuses what's missing: at `createRegistry` when it can, at the call otherwise. Never silently.
- **An adapter depends on another only through a core contract** (`SqlDatabase`, `JobsAdapter`). Re-exporting one, to save an import, is fine.
- **An option is correctness or capacity.** If two deployments with different values could end up with different data, it's correctness: a core option, on the definition or the registry. Otherwise it's capacity: the adapter's factory options, or `meta.<adapter>` on one definition.
- **The library defines no scope fields and holds no domain state:** the app's row is the truth.
