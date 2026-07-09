---
'@hyperlane-xyz/sdk': patch
---

The agent config schema gained an optional `index.interval` (seconds), letting the idle indexing/checkpoint poll interval be statically overridden from its default of 5s.
