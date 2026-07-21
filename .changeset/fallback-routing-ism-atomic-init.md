---
'@hyperlane-xyz/core': major
'@hyperlane-xyz/sdk': patch
---

`DefaultFallbackRoutingIsm` deployment was changed to set the owner, domains, and submodules directly in the constructor instead of a separate follow-up call, simplifying the deploy path in `HyperlaneIsmFactory`.
