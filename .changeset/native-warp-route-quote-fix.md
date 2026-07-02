---
'@hyperlane-xyz/sdk': patch
---

Fixed EvmHypSyntheticAdapter.quoteTransferRemoteGas miscounting the bridged amount as a native fee for native warp routes (token() == address(0)), which inflated the IGP quote and caused downstream consumers (e.g. the rebalancer) to over-reserve costs. The transfer amount is now subtracted from the internal-fee quote before quotes are classified as native or ERC20.
