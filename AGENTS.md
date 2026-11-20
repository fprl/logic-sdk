# AGENTS.md

Working on logic-sdk itself. For how apps use it, read the skill we ship: [`packages/logic-sdk/skills/logic-sdk/SKILL.md`](packages/logic-sdk/skills/logic-sdk/SKILL.md). Humans: start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

```bash
bun install
bun run test     # build, typecheck, lint, publint/attw, then core, CLI and both examples' tests
bun run --filter web dev   # docs site
```

## Layout

- `packages/logic-sdk`: the core (`src/index.ts`) and subpath adapters (`ai`, `orpc`, `fetch`, `drizzle`, `testing`). `skills/logic-sdk/SKILL.md` ships in the tarball.
- `packages/cli`: `logic-sdk list | show | graph | check`. Static analysis with oxc (`src/analyze.ts`), runtime facts from loading the registry (`src/project.ts`).
- `examples/shop` (one app on Node, Workers and Next.js) and `examples/bookings` (six modules): both tested against real Postgres (PGlite in tests).
- `apps/web`: the docs site.
- `DESIGN.md`: decisions and why. `RESEARCH.md`: how other stacks do it. `ROADMAP.md`: what's next.

## Rules

- **Done means `bun run test` passes,** plus `logic-sdk check` on both examples. Change the skill, the docs and the examples in the same change as the API.
- **Every change to a published package gets a changeset** (see CONTRIBUTING.md). No hand edits to `CHANGELOG.md` or versions.
- **Decisions go in DESIGN.md with the reason and what would change it.** Claims about other libraries cite a source; inference is labelled.
- **Reference stacks, in order:** Vercel, TanStack, Convex, then Rails, Laravel, Phoenix.
- **Keep the core small.** Adapter concerns live in adapters and their own `meta` namespace, never as core fields.
