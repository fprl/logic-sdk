# Contributing

Working on logic-sdk itself. Coding agents: see [AGENTS.md](AGENTS.md). How apps use logic-sdk lives in the skill we ship, [`packages/logic-sdk/skills/logic-sdk/SKILL.md`](packages/logic-sdk/skills/logic-sdk/SKILL.md).

```bash
bun install
bun run test     # build, typecheck, lint, publint/attw, core + CLI + both examples
```

## Issues first

**Open an issue; pull requests are for the team.** Pull requests are limited to collaborators, so a bug report, an idea or an API question starts as an issue: that's where the design gets settled, before anyone writes code. A good issue has what you tried, what you expected and what happened, ideally as a failing test or a few lines that reproduce it. If you'd like to join the team, say so in an issue.

## AI is welcome

This library is built with AI agents, and we're happy when you use them too, in issues and, once you're on the team, in code. The rule is the one [Ghostty](https://github.com/ghostty-org/ghostty/blob/main/CONTRIBUTING.md) uses: **you must understand and own every line you submit**, well enough to explain it without the AI. Say what you used when it shaped the change. Reports nobody checked by hand (an "issue" pasted from a model's guess) get closed.

## Changesets

Every change to a published package (`logic-sdk`, `@logic-sdk/cli`) needs a `.changeset/*.md`, written as user-facing prose with a migration note when something breaks. Skip it for docs, examples, CI and tests.

- **`patch`**: fixes and additive changes nobody needs to act on.
- **`minor`**: new features, and while we're on 0.x, breaking changes too.
- **`major`**: not before 1.0.

## Releases

- **0.x until people use it in production and it feels right.** SemVer allows anything to change in 0.x; we use the minor number to signal breaks.
- **Merge PRs freely, release in batches.** Pushing to `main` opens or updates the Version Packages PR; it waits until the batch is coherent. Merging it publishes to npm, tags, and creates the GitHub releases.
- **After 1.0:** many minors, rare majors, every breaking change a major with a migration note, like TanStack (Router has been on 1.x since Dec 2023).
