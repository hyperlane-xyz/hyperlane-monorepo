---
'@hyperlane-xyz/cli': patch
---

Warp apply merged fee-contract-owner transactions into the main submission when no dedicated `feeSubmitter` was configured and the main submitter materialized a payload/file artifact (e.g. Safe TX Builder, or an ICA wrapping one), so those collapsed into a single bundle / callRemote instead of being submitted separately. Live-broadcast submitters (e.g. JSON_RPC) kept fee transactions out of the retried main submission and submitted them in isolation, preserving fee-failure isolation. Fee transactions were also split into their own submission when a `feeSubmitter` was defined in the strategy.
