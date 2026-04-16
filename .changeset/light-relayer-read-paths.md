---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/relayer': patch
---

Migrated relayer read-only config derivation and metadata reads onto `MultiProviderAdapter` and widened the SDK EVM readers to accept the lighter read-provider interface.
