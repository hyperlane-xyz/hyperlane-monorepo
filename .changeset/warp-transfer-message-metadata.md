---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/rebalancer": patch
---

Added transferRemote and quoteTransferRemote overloads for caller-provided message metadata on native, ERC20 collateral, and synthetic warp routes. Matched native and ERC20 hook fee calculation to the complete dispatched message for Aleo private-minting support. Preserved the existing empty-metadata calls and specialized transfer behavior, and updated ethers callers to select the original signature explicitly.

Adjusted the cross-collateral optimizer settings to keep its inherited ABI below the EVM contract size limit.
