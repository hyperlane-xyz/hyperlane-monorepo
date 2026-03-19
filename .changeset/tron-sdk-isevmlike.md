---
'@hyperlane-xyz/sdk': patch
---

`isEVMLike()` replaced direct `ProtocolType.Ethereum` comparisons in `HyperlaneCore`, `RouterApps`, and `HyperlaneAppChecker` so Tron chains are correctly included in router configs, address lookups, and deploy checks.
