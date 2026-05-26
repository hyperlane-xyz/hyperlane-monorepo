---
"@hyperlane-xyz/sealevel-sdk": minor
---

The SVM synthetic warp reader and writer now populate the `SyntheticWarpArtifactConfig.token` field with the synthetic mint PDA derived from the warp program address, so the cross-VM orchestrator can see the deployed asset on every read and after every create.
