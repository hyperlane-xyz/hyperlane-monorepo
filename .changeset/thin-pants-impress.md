---
"@hyperlane-xyz/sdk": patch
---

Improve swap+bridge+ICA compose flows for metaswap integrations:

- Add reusable SDK helpers to build ERC20/warp/universal-router ICA call payloads and commitment hashes from raw calls.
- Harden `buildSwapAndBridgeTx` with explicit validation for slippage bounds and cross-chain fee configuration.
- Properly reserve cross-chain token fees from bridge funding to avoid underfunded `EXECUTE_CROSS_CHAIN` paths.
- Extend commitment-relayer payload schema to support both post-dispatch and pre-dispatch metadata shapes.
