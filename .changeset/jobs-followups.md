---
"logic-sdk": minor
---

**A job is settled before the jobs it queued run**, as a Laravel worker deletes a job before it pops the ones it pushed. A listener whose mutation emits an event was marked done only after that event's listeners finished, so a crash in one of them failed or reran it. They now run after it, and after the jobs queued alongside it, in every adapter that runs jobs, `inProcess()` and the test registry included.

**pg-boss: a crash on a job's last try reaches `onError`.** Rows get one spare retry: when pg-boss's supervisor expires the last try, the job comes back, and is failed without running again and reported.
