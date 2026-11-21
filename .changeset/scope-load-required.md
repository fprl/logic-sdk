---
"logic-sdk": minor
---

**An adapter that keeps jobs to run later needs `jobs.scope.load`.** A job that waits in an outbox or a queue would otherwise run with the roles of the day it was queued. `createRegistry` now throws without it for every adapter but `inProcess()` (`outbox`, `cloudflareQueue`, your own), like AshOban's `actor_persister` and Laravel's `SerializesModels`, which store ids and load them again when the job runs.

```ts
jobs: {
  adapter: outbox(db),
  scope: {
    store: (s) => ({ userId: s.user?.id ?? null, accountId: s.accountId }),
    load: (saved) => scopeFor(saved), // today's roles; null discards the job
  },
},
```

To keep the scope as it was, write it down: `load: (saved) => saved`. `inProcess()` is unchanged: nothing waits.
