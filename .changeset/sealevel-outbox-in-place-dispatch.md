---
'@hyperlane-xyz/sealevel-sdk': patch
---

The embedded Sealevel mailbox program was rebuilt so dispatch updated the outbox merkle tree in place instead of deserializing and re-serializing the whole outbox account, using about 2,300 fewer compute units per dispatch. Outbox account bytes were unchanged. Deployed programs must be upgraded to get the savings.
