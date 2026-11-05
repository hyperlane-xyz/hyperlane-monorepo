---
'@hyperlane-xyz/sdk': patch
---

Routing fee updates were deduplicated for destinations sharing a fee contract, preventing repeated ownership transfers from reverting atomic batches. ProxyAdmin ownership transactions were skipped for direct deployments without a ProxyAdmin. Shared fee updates were restricted to configured destinations, split deployments were reused, and quote signer sets were canonicalized to preserve existing quoted-fee addresses. Failed ProxyAdmin reads were propagated, and explicit ProxyAdmin configuration on direct deployments was reported.
