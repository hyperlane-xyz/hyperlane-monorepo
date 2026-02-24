---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': minor
---

Added `approveFeeTokenForHook` function to InterchainAccountRouter allowing pre-approval of ERC-20 fee tokens for hooks. This fixes an issue where ERC-20 fee payments fail when using StaticAggregationHook, since the router only approved the top-level hook but the actual fee transfer happens in a child hook (IGP).

SDK changes:

- Added `feeTokenApprovals` config field to `IcaRouterConfigSchema` for specifying fee token approvals at deploy time
- `InterchainAccountDeployer` now calls `approveFeeTokenForHook` for each configured approval after deployment
- `EvmIcaModule.update()` generates approval transactions for any missing fee token approvals
