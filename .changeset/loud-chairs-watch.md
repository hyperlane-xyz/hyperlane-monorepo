---
'@hyperlane-xyz/infra': minor
'@hyperlane-xyz/cli': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/helloworld': patch
'@hyperlane-xyz/utils': patch
'@hyperlane-xyz/core': patch
---

- CLI
  - add `oracleConfig` and `overhead` to hooks config
  - asking user for overhead, tokenExchangeRate
  - parsing IGPConfig (ZOD) to IGPConfig (SDK)
- _IGPDeployer_
  - if onchain storage oracle config doesn't match the desired oracleConfig (inside igpConfig)
  - _getStorageGasOracleConfigs_ - fetches nested storage gas oracle from within the coreConfig (e.g. core -> defaultHook -> routingHook -> igp -> oracleConfig)
  - added hardhat test for modifying oracle config
- refactoring and pulling building configs to SDK to make it independent of environment specific chains and state
  - `createIgpConfig`
  - `buildMultisigIsmConfigs`, `buildAggregationIsmConfigs`, etc
  - `buildRoutingOverAggregationIsmConfig` routing over aggregation of msgId and merkleTree (_current deployement_)
- test configs now in sdk (for configureGasOracle.hardhat-test.ts)
