---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/core': minor
---

The agent config schema and InterchainGasPaymaster events were updated to support origin fee-token IGP payments. Rust relayer fee-token enforcement requires origin chains to explicitly configure `igpVersion: latest`; missing versions are treated as legacy.
