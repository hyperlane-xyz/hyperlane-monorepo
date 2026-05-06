---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/sealevel-sdk': patch
---

CLI warp deploy and warp apply commands were wired to drive SVM fee program lifecycles. A new tokenFeeInputToFeeConfig mapping was added to bridge EVM SDK fee config inputs to provider-sdk fee types, and tokenFee was plumbed through validateWarpConfigForAltVM so YAML configs flow into the multi-VM deploy/update path. The four SVM fee writers were switched to deploy programs with exact-byte-length data accounts (matching the warp token writer convention), halving the rent paid for each fee program.
