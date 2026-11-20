# Contributing

Working on logic-sdk itself. Coding agents: see [AGENTS.md](AGENTS.md). How apps use logic-sdk lives in the skill we ship, [`packages/logic-sdk/skills/logic-sdk/SKILL.md`](packages/logic-sdk/skills/logic-sdk/SKILL.md).

```bash
bun install
bun run test     # build, typecheck, lint, publint/attw, core + CLI + both examples
```

## Changesets

Every change to a published package (`logic-sdk`, `@logic-sdk/cli`) needs a `.changeset/*.md`, written as user-facing prose with a migration note when something breaks. Skip it for docs, examples, CI and tests.

- **`patch`**: fixes and additive changes nobody needs to act on.
- **`minor`**: new features, and while we're on 0.x, breaking changes too.
- **`major`**: not before 1.0.

## Releases

- **0.x until people use it in production and it feels right.** SemVer allows anything to change in 0.x; we use the minor number to signal breaks.
- **Merge PRs freely, release in batches.** Pushing to `main` opens or updates the Version Packages PR; it waits until the batch is coherent. Merging it publishes to npm, tags, and creates the GitHub releases.
- **After 1.0:** many minors, rare majors, every breaking change a major with a migration note, like TanStack (Router has been on 1.x since Dec 2023).
