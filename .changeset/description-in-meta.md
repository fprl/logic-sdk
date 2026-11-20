---
"logic-sdk": minor
"@logic-sdk/cli": minor
---

Functions, listeners and events no longer take a `description`. Write one sentence of JSDoc above each export instead: editors show it on hover, and `logic-sdk list` and `show` print its first paragraph.

What an AI tool reads now lives in meta, owned by the adapter. `logic-sdk/ai` exports `AIMeta` (`{ ai?: { tool?: boolean; description?: string } }`) for your meta shape: `init<{ meta: AIMeta & AppMeta }>()`. `toAITools(registry, caller)` takes the exposed functions marked `meta: { ai: { tool: true } }` by default (`filter` is now optional), and a new `describe` option picks descriptions from your own meta. `toAITool(caller, fn, { description })` overrides one tool. Order: the call's option, then `meta.ai.description`, else none.

Migrate: move each `description: "…"` into a `/** … */` above the export; for AI tools, put the text in `meta: { ai: { description } }` and replace `filter: (f) => f.fn.meta?.agent === true` with `meta: { ai: { tool: true } }`.

The `logic-sdk` package now ships its agent skill at `skills/logic-sdk/SKILL.md`.
