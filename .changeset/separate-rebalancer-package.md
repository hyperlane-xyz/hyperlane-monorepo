---
"@hyperlane-xyz/rebalancer": minor
"@hyperlane-xyz/cli": minor
---

feat: separate rebalancer package

- Extract rebalancer logic from CLI into dedicated `@hyperlane-xyz/rebalancer` package
- New package supports both manual CLI execution and continuous daemon mode for K8s deployments
- CLI now imports from new package, maintaining backward compatibility for manual rebalancing
