---
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/cli': patch
---

Changed `readJson()` and `readYamlOrJson()` to return `T | null` on empty JSON files, for consistency with YAML behavior and simplified error handling. All call sites updated with explicit null checks using `assert()` or null coalescing.
