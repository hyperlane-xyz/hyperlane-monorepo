---
'@hyperlane-xyz/http-registry-server': minor
---

Added file watching for local filesystem registries. When the HTTP registry server is started with a local filesystem registry (or a MergedRegistry containing one), it now watches for changes to YAML/JSON files and automatically refreshes the registry cache when changes are detected.
