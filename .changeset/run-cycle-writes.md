---
"@logic-sdk/cli": patch
---

`run-cycle` counts only runs into mutations and actions. Modules may read each other both ways: a properties page running a bookings query while creating a booking runs a properties query is no longer an error. A query can't write, emit or schedule, so that can't re-enter a transaction. The fix message now says to make one direction an event, or move the write into the module that owns the data.
