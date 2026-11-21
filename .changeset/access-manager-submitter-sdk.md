---
'@hyperlane-xyz/sdk': major
---

Added the `accessManager` transaction submitter for contracts governed by an OpenZeppelin v5 AccessManager. It wraps each transaction in an AccessManager `schedule` or `execute` call and sends it through the configured `proposerSubmitter`. When the optional `caller` is set, calls it can make immediately are executed and delayed ones are scheduled; otherwise every call is scheduled. Strategy validation requires `caller` to match the proposer's Safe, timelock or jsonRpc `userAddress` when the config contains one. The `execute` transactions for scheduled calls are returned after the proposer output so they can be submitted once the delay has passed. Also added an optional `refundAddress` to the interchain account submitter, required when the ICA is owned by an AccessManager.
