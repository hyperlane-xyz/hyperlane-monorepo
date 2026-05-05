---
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/sdk': patch
---

SVM warp route fee integration was added — warp tokens can now reference a deployed fee program via SetFeeConfig, with full create/read/update support and fee PDA validation. Token account decoder was updated to read the trailing Option<FeeConfig> field. Program version detection was added via GetProgramVersion simulation, enabling explicit program upgrades with ExtendProgramChecked and version-gated upgrade flow. Added contractVersion field to provider-sdk warp config types. compare-versions package added to workspace catalog.
