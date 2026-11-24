---
"@logic-sdk/cli": patch
---

The CLI reads modules in workspace packages: paths are real paths, as Node and TypeScript resolve them, so a module linked into `node_modules` is no longer skipped as a dependency. `list` also reports what's defined in files no module imports (a forgotten `export * from "./listeners"`), from every file in the registry's folder and each module's, tests aside.
