---
"logic-sdk": patch
---

`query`, `mutation` and `action` have one typed signature instead of five overloads. Same rules, clearer mistakes: `expose: true` without `output` now says "Property 'output' is missing" instead of "No overload matches this call", and a wrong return type points at the handler. Type-checking cost is unchanged (within 10%).
