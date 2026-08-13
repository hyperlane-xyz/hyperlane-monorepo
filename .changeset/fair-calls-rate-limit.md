---
'@hyperlane-xyz/ccip-server': patch
---

The CCIP server rate limits were isolated by client and request class behind the GCE ingress, with endpoint-specific rejection metrics added.
