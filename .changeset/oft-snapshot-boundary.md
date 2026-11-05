---
'@hyperlane-xyz/rebalancer': patch
---
OFT settlement reused the shared receipt verifier and was bounded by the exact collateral snapshot. Named finality was resolved once, failed snapshot reads deferred execution, and effective OFT routes were validated after destination overrides to prevent incompatible endpoint configurations from starting.
