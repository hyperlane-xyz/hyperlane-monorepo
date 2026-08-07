---
'@hyperlane-xyz/sdk': patch
---

The SDK fee-token resolution now supports xERC20 and xERC20Lockbox warp routes. Previously `getFeeTokenAddress` threw `Unsupported token type for fee resolution` for these types, which blocked applying a `tokenFee` (including OQLF) to xERC20 routes via `warp deploy`/`warp apply`. For plain xERC20 the fee token resolves to the configured xERC20 token. For xERC20Lockbox the deploy config stores the lockbox address, but the router's `token()`/`feeToken()` returns the underlying wrapped ERC20; fee-token resolution now reads this on-chain for the lockbox variant so the deployed fee contract's token matches `token()` and passes the router's `fee must match token` check. Added SDK unit and hardhat tests (including an xERC20Lockbox deploy regression) plus CLI e2e tests asserting xERC20 and xERC20Lockbox routes can be deployed with fees and updated.
