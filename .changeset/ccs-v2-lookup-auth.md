---
'@hyperlane-xyz/ccip-server': minor
---

The CCS reveal lookup (POST) required framed (v2) relayer signatures instead of the packed (v1) format; a POST body without v2 credentials, including one signed with v1, was answered with 401. A v2 body was required to carry a non-empty hex `origin_tx_hash`, and the reveal handler used only that signed value; a missing, null or empty one was answered with 401. A v2 request was accepted only when its `issued_at` was at most `CCS_AUTH_MAX_AGE_SECONDS` old and at most 5 seconds ahead of the server clock, and only when its signed `message_id` was the id of the reveal message being looked up. `CCS_AUTH_MAX_AGE_SECONDS` defaulted to 30 when unset and otherwise had to be decimal seconds from 10 to 120, or startup failed. The calldata lookup (GET) kept the v1 format.
