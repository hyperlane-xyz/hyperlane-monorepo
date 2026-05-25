---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/provider-sdk': minor
---

CLI warp deploy and warp apply commands were wired to drive SVM fee program lifecycles. A new tokenFeeInputToFeeConfig mapping was added to bridge EVM SDK fee config inputs to provider-sdk fee types, and tokenFee was plumbed through validateWarpConfigForAltVM so YAML configs flow into the multi-VM deploy/update path. The fee config input schema gained an optional beneficiary field so operators can set a beneficiary distinct from the owner; tokenFeeInputToFeeConfig now respects it (defaulting to owner when omitted) instead of forcing beneficiary = owner. tokenFeeInputToFeeConfig also now prefers raw maxFee/halfAmount over the schema's derived bps when both are present, so YAML configs authored as raw round-trip without silent bps conversion. The four SVM fee writers were switched to deploy programs with exact-byte-length data accounts (matching the warp token writer convention), halving the rent paid for each fee program. SvmWarpArtifactManager is now publicly exported from sealevel-sdk. provider-sdk now exports `DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY` from `@hyperlane-xyz/provider-sdk/warp` for downstream CLI/test code that needs to reference the wildcard cross-collateral target-router slot without depending on the main SDK.
