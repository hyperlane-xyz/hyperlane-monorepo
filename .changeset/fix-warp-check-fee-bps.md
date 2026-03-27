---
'@hyperlane-xyz/sdk': patch
---

Fixed warp check to compare bps instead of maxFee/halfAmount for fee configs. Previously, warp check showed false violations because on-chain configs store derived maxFee/halfAmount values while deploy configs specify bps. The transform now handles each fee type appropriately: LinearFee and RoutingFee compare bps only, while ProgressiveFee and RegressiveFee preserve maxFee/halfAmount for direct comparison.
