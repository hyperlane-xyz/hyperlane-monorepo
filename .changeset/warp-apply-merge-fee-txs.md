---
'@hyperlane-xyz/cli': patch
---

Warp apply now merges fee-contract-owner transactions into the main submission when no dedicated `feeSubmitter` is configured, so a single submitter produces one batch (one callRemote / one receipts file) instead of broadcasting fee transactions separately. Fee transactions are only split into their own submission when a `feeSubmitter` is defined in the strategy.
