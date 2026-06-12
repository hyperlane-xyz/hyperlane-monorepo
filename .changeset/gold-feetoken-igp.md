---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/core': minor
---

The agent config schema and InterchainGasPaymaster events were updated to support origin fee-token IGP payments. Rust relayer fee-token enforcement required origin chains to explicitly configure `igpVersion: latest`; missing versions were treated as legacy.
