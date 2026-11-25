---
'@hyperlane-xyz/sdk': minor
---

Added `offchainLookupRequestHash` and its `OffchainLookupRequest` type, which hash the framed (v2) offchain lookup authentication payload. The payload binds the URL template, sender, call data, message id, origin transaction hash and signing time. `offchainLookupRequestMessageHash` was left unchanged.
