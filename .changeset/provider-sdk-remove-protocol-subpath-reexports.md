---
'@hyperlane-xyz/provider-sdk': major
---

Breaking: the `./protocol` subpath no longer re-exports `ProtocolType`, `ProtocolTypeValue`, or `ProtocolSmallestUnit`. These were moved to the new `./protocolType` module to break an import cycle. Import them from the main `@hyperlane-xyz/provider-sdk` entry instead.
