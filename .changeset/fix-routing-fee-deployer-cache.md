---
"@hyperlane-xyz/sdk": patch
---

Fixed RoutingFee deployer reusing the same LinearFee contract for all destinations regardless of different bps values. A parameter-aware cache was added so destinations with identical bps share a contract while different bps get separate deployments.
