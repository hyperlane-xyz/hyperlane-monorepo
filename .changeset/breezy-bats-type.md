---
'@hyperlane-xyz/sdk': patch
---

Granular control of updating predeployed routingIsms based on routing config mismatch
- Add support for routingIsmDelta which filters out the incompatibility between the onchain deployed config and the desired config.
- Based on the above, you either update the deployed Ism with new routes, delete old routes, change owners, etc.
- `moduleMatchesConfig` uses the same
