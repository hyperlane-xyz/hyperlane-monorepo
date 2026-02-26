---
'@hyperlane-xyz/sdk': minor
---

SDK support for `approveFeeTokenForHook`:

- Added `feeTokenApprovals` config field to `IcaRouterConfigSchema` for specifying fee token approvals at deploy time
- `InterchainAccountDeployer` now calls `approveFeeTokenForHook` for each configured approval after deployment
- `EvmIcaModule.update()` generates approval transactions for any missing fee token approvals
