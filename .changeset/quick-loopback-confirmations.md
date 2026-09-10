---
'@hyperlane-xyz/sdk': patch
---

Adjusted ethers v5 polling to the chain's estimated block time, capped at four seconds, reducing confirmation detection latency on fast chains including those with sub-second blocks. Providers using only loopback RPC URLs used 100ms polling for local deployments and CLI E2E tests. Chains without a block-time estimate retained the four-second default.
