---
'@hyperlane-xyz/sdk': patch
---

Added batched transaction submission for hook, IGP, and routing ISM deployments to avoid hitting gas limits on chains with lower block gas caps. Chain-specific batch size overrides were added (e.g. citrea). Routing ISM deployment was refactored to deploy with an initial batch of domains and enroll the remainder individually, with per-chain initialization sizes. The gas buffer multiplier was increased for ISM factory deployments. A configurable `minConfirmationTimeoutMs` option was added to `MultiProvider`.
