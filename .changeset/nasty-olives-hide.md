---
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/utils': patch
'@hyperlane-xyz/cli': patch
---

Changed `readJson()` and `readYamlOrJson()` to return null on empty JSON files, for consistency with YAML behavior and simplified error handling.
