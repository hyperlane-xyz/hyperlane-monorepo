---
'@hyperlane-xyz/sdk': major
---

Added the `accessManager` transaction submitter for contracts governed by an OpenZeppelin v5 AccessManager:
- Each transaction is wrapped in an AccessManager `schedule` or `execute` call and sent through the configured `proposerSubmitter`.
- With the optional `caller` set, immediate calls are executed and delayed ones are scheduled; without it, every call is scheduled.
- Once a call is scheduled, later immediate calls are also returned as `execute` transactions, including in later `submit()` calls, so the original order is kept.
- The `execute` transactions are returned after the proposer output and must be submitted in that order once the delay has passed.
- Delayed calls whose operation is already scheduled are not scheduled again; only their `execute` is returned.
- Strategy validation checks `caller` against the proposer's Safe, timelock or jsonRpc `userAddress` when the config has one.

Added an optional `refundAddress` to the interchain account submitter, required when the ICA is owned by an AccessManager.
