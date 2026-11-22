---
"logic-sdk": minor
---

`startTicking`: a hung job no longer stops every later sweep. Sweeps start every `sweepEvery` seconds without waiting for the last, like ticks, so a process can now run several at once (ten at most, then the next is skipped and reported to `onError`).
