---
'@hyperlane-xyz/rebalancer': minor
---

Added the deBridge DLN external bridge for moving USDT inventory across BSC, Tron, Ethereum, Arbitrum, Plasma, and Solana. The quote fee guard normalizes token decimals before comparing source and destination amounts, so cross-decimal routes (e.g. BSC USDT 18dp to Tron USDT 6dp) are no longer rejected as ~100% fee.
