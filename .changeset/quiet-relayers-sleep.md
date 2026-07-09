---
'@hyperlane-xyz/sdk': patch
---

The agent config schema gained an optional `index.dynamicBlockIntervals` boolean, mirroring a new relayer setting that scales the idle indexing poll interval to a chain's `estimateBlockTime` (capped at 5s) instead of a fixed 5s, when explicitly enabled.
