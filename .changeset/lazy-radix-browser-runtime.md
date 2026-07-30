---
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/sdk': patch
---

Lazy-loaded the Radix browser provider and exposed token metadata through its public async API so applications without active Radix usage no longer include the Radix Engine Toolkit in their initial bundle.
