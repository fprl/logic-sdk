---
"logic-sdk": minor
---

`logic-sdk/node`: `startTicking(registry, { sweepEvery? })` is a long-running process's cron trigger, like Laravel's `schedule:work`. It ticks your crons on every minute without waiting for the last tick, and sweeps on its own loop, so a slow cron or sweep never skips a minute. A minute the process wasn't running for is skipped. Returns `stop()`.
