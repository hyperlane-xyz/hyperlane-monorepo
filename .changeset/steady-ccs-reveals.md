---
'@hyperlane-xyz/ccip-server': patch
---

Reveal lookups in the call commitments service were changed:

- The origin transaction hash is required.
- Calls are only returned for reveals sent between registry ICA routers, when the commitment sent with the reveal matches the stored ICA. Other reveals receive HTTP 403.
- The service fails to start if the registry lists no ICA routers, or lists a chain with ICA routers but no mailbox.
- Origin mailboxes are read from the registry addresses at startup, so reveals from chains that list only `interchainAccountRouterV3` are resolved.
- `GET /calldata/:commitment` is disabled by default while the Sealevel reveal flow is redesigned; set `CCS_CALLDATA_LOOKUP_ENABLED=true` to enable it.
