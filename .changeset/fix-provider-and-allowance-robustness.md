---
"@hyperlane-xyz/sdk": patch
---

`EvmTokenAdapter.isApproveRequired`/`isRevokeApprovalRequired` were hardened to normalize the `allowance()` result through `BigNumber.from()` before comparing it, avoiding a `TypeError` when a substituted provider returned a non-`BigNumber` value. `WarpCore.getLocalTransferFee` was updated to return a conservative hard-coded gas estimate for Seismic-technicalStack origin chains instead of throwing, since unsigned `eth_call`/`eth_estimateGas` zeroes `msg.sender` on Seismic and breaks any handler logic keyed on it (e.g. `HypERC20`'s burn-on-transfer).
