## [2.0.0] - 2026-01-06

* feat: always log metadata bytes as hex (#7566)
* feat: rotate provider if eth_getTransactionReceipt returns JSON null (#7489)

## [1.6.0] - 2025-11-06

* feat(lander): Builder stage popping several payloads at a time (#6557)
* feat(lander): more advanced nonce manager (#6504)
* feat: Cap gasPrice escalation (by Claude) (#6862)
* feat: Deprioritize failed providers (#6613)
* feat: add gas limit cap (#6879)
* feat: change span to debug (#6663)
* feat: fallback to single tx submission if batching fails (#7247)
* fix: Add log on value is null (#7325)
* fix: Add provider host to logging for EVM (#7068)
* fix: Lander nonce add logs (#7260)
* fix: Request more fee history percentiles if default one returned zeros (#7047)
* refactor: align radix custom rpc header with evm implementation (#7110)
