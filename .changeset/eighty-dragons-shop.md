---
"@hyperlane-xyz/sdk": minor
---

Fixed critical schema bug where SealevelIgpData.gas_oracles was incorrectly typed as Map<number, bigint> instead of Map<number, SealevelGasOracle>, preventing proper deserialization of on-chain gas oracle state. Added SealevelRemoteGasData, SealevelGasOracle, and related Borsh schemas to match the Rust implementation. Implemented createSetGasOracleConfigsInstruction() and createSetDestinationGasOverheadsInstruction() methods on the IGP adapters, along with gasOracleMatches() helper with BigInt-safe comparison for detecting configuration drift between expected and actual on-chain values.
