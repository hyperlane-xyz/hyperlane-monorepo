---
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/cli': patch
---

Hook update logic now compares actual and expected configs to prevent unnecessary redeployments when applying the same config multiple times. Protocol capability check ensures hook updates only attempted on Aleo. Test suite added for hook update validation.
