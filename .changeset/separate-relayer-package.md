---
"@hyperlane-xyz/relayer": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/infra": patch
---

Extracted relayer into dedicated `@hyperlane-xyz/relayer` package

- Moved `HyperlaneRelayer` class from SDK to new package
- New package supports both manual CLI execution and continuous daemon mode for K8s deployments
- CLI and infra now import from new package
- **Breaking**: `HyperlaneRelayer`, `RelayerCacheSchema`, and `messageMatchesWhitelist` are no longer exported from `@hyperlane-xyz/sdk`
