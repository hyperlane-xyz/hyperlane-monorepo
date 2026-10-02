---
'@hyperlane-xyz/sdk': patch
---

Routing fee updates were deduplicated for destinations sharing a fee contract, preventing repeated ownership transfers from reverting atomic batches. ProxyAdmin ownership transactions were skipped for direct deployments without a ProxyAdmin.
