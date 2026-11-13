---
'@hyperlane-xyz/ccip-server': patch
---

Reveal lookups in the call commitments service were changed:

- The origin transaction hash is required.
- Calls are only returned for reveals sent between registry ICA routers, when the commitment sent with the reveal matches the stored ICA. Other reveals receive HTTP 403.
- The service fails to start if the registry lists no ICA routers, or lists a chain with ICA routers but no mailbox.
- Origin mailboxes are read from the registry addresses at startup, so reveals from chains that list only `interchainAccountRouterV3` are resolved.
- Candidate ICAs that the chain answers as underivable do not match; only candidates whose chain read fails return HTTP 500.
- Reveals whose dispatched routers the chain answers as unable to derive the ICA receive HTTP 403; a failed read of those routers returns HTTP 500.
- `GET /calldata/:commitment` is disabled by default while the Sealevel reveal flow is redesigned; set `CCS_CALLDATA_LOOKUP_ENABLED=true` to enable it.

HTTP 500 responses from the lookup handlers return `Internal server error`, except pending CCTP attestations and Wormhole VAAs, which keep their message. URLs and hostnames are removed from logged RPC errors and from the HTTP 400 returned when the ICA of a new commitment cannot be derived.
