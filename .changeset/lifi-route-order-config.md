---
"@hyperlane-xyz/rebalancer": minor
---

Refactored external bridge type system to be generic and extensible. ExternalBridgeConfig is now generic with nested bridgeOptions per bridge type. IExternalBridge accepts typed quote overrides. Added per-strategy routeOrder config for LiFi bridge with three-level resolution (per-strategy override, global default, hardcoded fallback).
