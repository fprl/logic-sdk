---
"logic-sdk": patch
---

The skill says where a private function goes: unexported in the file that runs it, or in `data.ts` when two files share it, never exported from `mutations.ts`, where `export *` would publish it.
