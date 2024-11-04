---
'@hyperlane-xyz/utils': major
'@hyperlane-xyz/cli': major
'@hyperlane-xyz/sdk': major
---

Detangle assumption that chainId == domainId for EVM chains. Domain IDs and Chain Names are still unique, but chainId is no longer guaranteed to be a unique identifier. Domain ID is no longer an optional field and is now required for all chain metadata.
