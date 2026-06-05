---
'@hyperlane-xyz/sdk': patch
---

The SDK core and IGP deployers were updated to support recover-only legacy IGP configurations and opt out of QuotedCalls deployments. The IGP hook config gained an optional `tokenOracleConfig` (keyed by fee token then remote chain) that wires per-fee-token gas oracles via `setTokenGasOracles` for ERC20-denominated interchain gas payments. Each fee token is backed by its own `StorageGasOracle`, oracle addresses are resolved from the on-chain `tokenGasOracles` mapping (no off-chain bookkeeping), and the path is gated behind non-legacy IGPs at contract version >= 11.3.0.
