---
'@hyperlane-xyz/sdk': patch
---

Fixed `getCallRemote` in InterchainAccount to query ISM using origin domain instead of destination domain. The `isms` mapping is indexed by origin (where messages come FROM), not destination.
