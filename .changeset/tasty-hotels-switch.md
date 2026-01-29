---
"@hyperlane-xyz/sdk": patch
---

Fixed legacy ICA router support in InterchainAccount: use routerOverride for gas estimation and ISM lookup, and query mailbox directly for accurate quotes on legacy routers that don't support hookMetadata.
