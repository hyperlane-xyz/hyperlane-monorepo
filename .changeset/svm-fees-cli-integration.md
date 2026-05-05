---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cli': patch
---

SVM fee programs can now be deployed and managed via CLI warp deploy and warp apply commands. Added tokenFeeConfigInputToProviderFeeConfig mapping to bridge EVM SDK fee config types (bps/owner) to provider-sdk fee types (params/beneficiary). Wired tokenFee through validateWarpConfigForAltVM so CLI YAML configs with tokenFee are forwarded to the multi-VM deploy/update flow.
