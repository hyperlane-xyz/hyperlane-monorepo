---
'@hyperlane-xyz/sdk': patch
---

Fixed XERC20 type detection (deriveXERC20TokenType) for xERC20 tokens deployed behind a proxy: it now resolves the implementation address and inspects its bytecode for the Velodrome/Standard selectors, instead of only checking the (delegatecall-stub) proxy bytecode. This fixes "Unable to detect XERC20 type … does not implement Standard or Velodrome XERC20 interface" for proxied xERC20 warp routes.
