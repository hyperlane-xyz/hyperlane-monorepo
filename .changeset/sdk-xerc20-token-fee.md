---
'@hyperlane-xyz/sdk': major
---

The SDK fee-token resolution now supports xERC20 and xERC20Lockbox warp routes. Previously `getFeeTokenAddress` threw `Unsupported token type for fee resolution` for these types, which blocked applying a `tokenFee` (including OQLF) to xERC20 routes via `warp deploy`/`warp apply`. Fee-token resolution now reads the router's `token()` on-chain for both xERC20 variants so the deployed fee contract's token matches `token()` and passes the router's `fee must match token` check (for xERC20Lockbox this is the underlying wrapped ERC20, not the stored lockbox address). As part of this the exported `resolveTokenFeeAddress` (subpath `@hyperlane-xyz/sdk/token`) is now async and takes an additional `provider` argument, which is a breaking change for downstream callers. Added SDK unit and hardhat tests (including an xERC20Lockbox deploy regression) plus CLI e2e tests asserting xERC20 and xERC20Lockbox routes can be deployed with fees and updated.
</content>
</invoke>
