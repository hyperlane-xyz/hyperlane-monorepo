---
'@hyperlane-xyz/sdk': patch
---

Squads runtime utilities were hardened against prototype-pollution and hostile input edge cases by routing risky member operations through captured builtins and guarded access helpers, with regression coverage added to lock the behavior.
