---
'@hyperlane-xyz/core': patch
'@hyperlane-xyz/sdk': patch
---

Added IMulticall3 Solidity interface for typechain generation, replacing the hand-rolled MULTICALL3_ABI constant.
Added MultiProvider multicall plumbing and chain-address configuration for resolving batch contract addresses.
