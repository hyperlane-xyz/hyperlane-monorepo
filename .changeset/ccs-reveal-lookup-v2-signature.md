---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/ccip-server': minor
'@hyperlane-xyz/relayer': minor
---

Added `offchainLookupRequestHash` and its `OffchainLookupRequest` type, which hash the framed (v2) offchain lookup authentication payload. The payload binds the URL template, sender, call data, message id, origin transaction hash and signing time. `offchainLookupRequestMessageHash` was left unchanged.

The CCS reveal lookup (POST) required framed (v2) relayer signatures instead of the packed (v1) format; a POST body without v2 credentials, including one signed with v1, was answered with 401. A v2 body was required to carry a non-empty hex `origin_tx_hash`, and the reveal handler used only that signed value; a missing, null or empty one was answered with 401. A v2 request was accepted only when its `issued_at` was at most `CCS_AUTH_MAX_AGE_SECONDS` old and at most 5 seconds ahead of the server clock, and only when its signed `message_id` was the id of the reveal message being looked up. `CCS_AUTH_MAX_AGE_SECONDS` defaulted to 30 when unset and otherwise had to be decimal seconds from 10 to 120, or startup failed. The calldata lookup (GET) kept the v1 format. Each 401 kept the same response body and was logged with its `reason`, and a reveal whose signed `message_id` did not match was logged with both ids before the 403.

The TypeScript relayer signed only CCS reveal lookups, those whose call data starts with the `getCallsFromRevealMessage(bytes)` selector, using the framed (v2) payload instead of the packed (v1) one. Their POST body carried the delivered message's `message_id` and the signing time as `issued_at`. Other offchain lookup POST requests were sent without a signature, `message_id` or `issued_at`. A reveal lookup was signed and sent only when its `getCallsFromRevealMessage` argument was the message being delivered; other reveal POSTs were skipped. The signed reveal POST refused redirects, so its body was not forwarded to another host.
