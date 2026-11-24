---
"@logic-sdk/cli": patch
---

`list`, `show` and `graph` show private functions (ones their module's index doesn't export) as the runtime names them, `files.(private) record` or `files.<id>`, with their own edges. `list` also shows listeners, crons and events no index exports, which never run. What no index reaches is found by its definer from `init()`, aliases included, and a run the CLI can't resolve shows as `(dynamic)` instead of a guessed name.
