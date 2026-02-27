---
'@hyperlane-xyz/sdk': patch
---

Fixed `getHypAdapter` to handle `EvmNative` tokens with warp connections by returning `EvmHypNativeAdapter`, enabling cross-chain transfers for mint/burn native gas tokens. Also fixed gas estimation in `WarpCore.getLocalTransferFee` to use a decimal-aware amount that survives on-chain truncation between chains with different decimals.
