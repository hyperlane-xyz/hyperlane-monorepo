---
'@hyperlane-xyz/infra': patch
---

Added a fail-closed aggregation ISM to every EVM leg of the Eclipse USDT warp config getter, wrapping a rate-limited ISM (~$50k/day inbound cap), a pausable ISM, and a default fallback routing ISM. The rate-limited and pausable ISMs are owned by the Haggis-operated Turnkey pauser key for fast emergency response, while the fallback routing ISM stays with each leg's governance owner.
