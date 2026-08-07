---
'@hyperlane-xyz/sdk': patch
---

The SDK fee-token resolution now supports xERC20 and xERC20Lockbox warp routes. Previously `getFeeTokenAddress` threw `Unsupported token type for fee resolution` for these types, which blocked applying a `tokenFee` (including OQLF) to xERC20 routes via `warp deploy`/`warp apply`. It now returns the wrapped/collateral token address, matching the contract's `feeToken()` which returns `token()` when a fee hook is set. Added SDK hardhat tests for the xERC20 fee-setting path and CLI e2e tests asserting xERC20 routes can be deployed with fees and updated.
