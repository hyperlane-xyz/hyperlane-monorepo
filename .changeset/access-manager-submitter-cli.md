---
'@hyperlane-xyz/cli': minor
---

Added the `accessManager` submitter to submission strategies:
- Any submitter, including CLI-only ones such as `file`, can be its `proposerSubmitter`.
- `--relay` supports interchain account submitters whose `internalSubmitter` is an `accessManager` with a `jsonRpc` proposer. Receipts that dispatch no message are not relayed.
- `warp apply --relay` also relays messages dispatched by fee and ownership transactions.
- `warp apply` adds Safe Transaction Builder payloads from `timelockController` and `accessManager` results to the combined Safe bundle and writes the deferred `execute` transactions to the receipts file.
- Added example strategies.
