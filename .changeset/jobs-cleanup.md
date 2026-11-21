---
"logic-sdk": patch
---

Jobs internals tidied after review: one helper for a scheduled call's replace key, exported for adapter authors as `replaceKeyOf(job)`; `inProcess()` is one shared instance; fewer casts; error messages and docs say "adapter" throughout and name crons and scheduled calls where they said only listeners.
