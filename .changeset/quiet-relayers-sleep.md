---
'@hyperlane-xyz/sdk': patch
---

The agent config schema gained an optional `index.interval` (seconds), letting the idle indexing poll interval (default 5s) and the validator checkpoint poll interval (default 2s) be statically overridden.
