---
'@hyperlane-xyz/core': minor
---

Added L1FluentHypNative, an Ethereum-side HypNative variant that forwards inbound native-ETH deliveries through L1HypNativeGateway (which wraps Fluent's L1→L2 bridge) instead of releasing on L1, while keeping outbound transferRemote and protocol-fee delivery unchanged on L1.
