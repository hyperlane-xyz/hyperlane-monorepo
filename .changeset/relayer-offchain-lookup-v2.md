---
'@hyperlane-xyz/relayer': minor
---

The relayer signed only CCS reveal lookups, those whose call data starts with the `getCallsFromRevealMessage(bytes)` selector, using the framed (v2) payload instead of the packed (v1) one. Their POST body carried the delivered message's `message_id` and the signing time as `issued_at`. Other offchain lookup POST requests were sent without a signature, `message_id` or `issued_at`. A reveal lookup was signed and sent only when its `getCallsFromRevealMessage` argument was the message being delivered; other reveal POSTs were skipped.
