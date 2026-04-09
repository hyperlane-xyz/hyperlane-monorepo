---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/sdk': major
---

Warp route checks were unified onto the shared CLI comparison flow, including explicit proxyAdmin address checks and owner override ownership checks. The legacy `HypERC20App` and `HypERC20Checker` SDK exports were removed.
