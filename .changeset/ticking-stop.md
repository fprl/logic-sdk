---
"logic-sdk": minor
---

`startTicking`:

- **`stop()` returns a promise** that resolves once the running ticks and sweep finish, or after `timeout` seconds (`stop({ timeout })`, default 30, like pg-boss). `await` it in your SIGTERM handler.
- **Ticks don't pile up:** with ten still running (an unreachable database), the next minute is skipped and reported to `onError`, instead of a backlog of stale minutes running when it comes back.
- **A throwing `onError` is caught,** so it can't stop the sweep loop.
