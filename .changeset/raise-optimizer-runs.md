---
"@hyperlane-xyz/core": patch
---

The Solidity optimizer runs were raised from 5,800 to 10,000 for the whole suite, lowering runtime gas across the contracts. `CrossCollateralRouter` is pinned at 5,800 runs — via a Foundry compilation restriction and a matching Hardhat override — so its runtime bytecode stays under the EIP-170 24,576-byte limit.
