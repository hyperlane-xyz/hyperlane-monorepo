---
'@hyperlane-xyz/sealevel-sdk': major
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/sdk': patch
---

SVM warp route fee integration was added. Warp token writers wired SetFeeConfig into the create and update flows with fee PDA validation, and readers were updated to surface the on-chain fee config. The token account decoder was extended to read the trailing Option<FeeConfig> field. Program version detection was added via GetProgramVersion simulation, gating explicit program upgrades that emit ExtendProgramChecked and Upgrade against the deployed BPF Loader v3 program. A contractVersion field was added to the provider-sdk warp config types, and compare-versions was promoted to the workspace catalog.
