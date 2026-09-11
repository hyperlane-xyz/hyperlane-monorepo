## [3.0.0] - 2026-09-11

* feat(agents): persist backward index progress (#9325)
* feat(scraper): index merkle tree insertions (#9276)
* feat(scraper-proxy): add durable gas payment cursors (#9393)
* feat: add scraper DB GraphQL proxy (#9238)
* fix(rust): heartbeat idle contract sync tasks (#9222)
* fix(scraper)!: compact scraper cursor table (#9258)
* fix(scraper): back off incomplete sequence ranges (#9165)
* fix(scraper): bound and streamline event ingestion (#9476)
* fix(scraper): inherit Ethereum reorg period (#9600)
* fix(scraper): persist events with unresolvable log meta (#9284)
* perf(scraper): add opt-in indexes for scoped event counts (#9491)
* perf(scraper): back off raw dispatch reconciliation scans (#9226)
* perf(scraper): reduce enrichment and sequence lookup work (#9468)
* perf(scraper): retry known raw dispatches directly (#9449)
* perf(scraper): short-circuit failed Sealevel IGP ranges (#9227)
* perf(scraper): streamline CCR replay and cursor persistence (#9521)
* perf: speed up builds and e2e tests (#9529)

## [2.3.0] - 2026-07-20

* chore: jun 5 deprecations (21 chains) (#8860)
* feat(tron): migrate Tron agents from gRPC to HTTP API (#8370)
* feat: index same chain ccr swaps (#8796)
* feat: static interval override for idle indexing and validator checkpoint polling (#8989)
* fix(scraper): retry dispatches on partial enrichment (#8891)
* refactor(evm): remove evm tron techstack (#8408)
* test(tron): agent e2e tests (#8427)

## [2.1.0] - 2026-03-04

* feat(agents): add chain configuration metrics (#8185)
* feat(tron): add ethereum compatibility & tron aws signer (#8222)
* feat: Store Raw Message Dispatches (#7714)
* fix(scraper): Optimize message_view query performance
* fix(scraper): Reorder message unique index to support origin-only queries (#7945)
* fix(scraper): add retry logic to init-db database connection (#8068)

## [2.0.0] - 2026-01-06

* chore: deprecate form, inevm, injective, mint, neutron, osmosis, svmbnb (#7646)
* feat(rust): feature-gate Aleo chain support to reduce CI build times (#7569)
* feat: rotate provider if eth_getTransactionReceipt returns JSON null (#7489)

## [1.6.0] - 2025-11-06

* chore: deprecate cheesechain (#7307)
* feat: Override the lowest block height with value from settings (#6451)
* feat: radix e2e tests (#7060)
* feat: try to build cursor multiple times before giving up (#7225)
* fix: Add domain into spans in Scraper (#6846)
* fix: Improve logging for cursor creation (#6836)
* fix: Scraper: Do nothing when block with hash is already in database (#7289)
