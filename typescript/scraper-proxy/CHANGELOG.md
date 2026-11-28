# @hyperlane-xyz/scraper-proxy

## 0.2.0

### Minor Changes

- 63228b2: Removed historical agent WebSocket backfills, replay cursors, catch-up frames and metrics, and the subscription metric's state label. Limited agent frames to 64 KiB and documented per-type, mid-range live starts and the required RPC overlap.

  Required deployment of the validator and relayer RPC-recovery refactors (#10038 and #10039), or explicit RPC-only configuration for older agents, before the proxy upgrade. Accepted the metrics compatibility break; the single affected dashboard will be updated separately. Kept public endpoint exposure and the central snapshot service as separate follow-ups.

- 9807309: Added optional per-domain agent confirmation policies so one subscription can use different confirmation delays across chains while preserving legacy subscriptions.
- 40c13c9: Added a public, live-only /validators WebSocket for single-domain Merkle insertions with optional confirmation counts, shared readers, bounded admission, and usage metrics. Validator-only reads were isolated from the internal live pool. Deployment requires a supporting proxy image before switching validator images and endpoint URLs.

### Patch Changes

- 0654ab7: Restricted public GraphQL history filters, ordering and aggregates, rejected expensive PostgreSQL plans before execution, bounded unfinished database work and WebSocket setup, and reduced the cost of provisional delivery lookups.
- 9808703: Added the gateway hostname, sanitized URL template, and observation time to CCIP-read diagnostics. Successful reads also included the decoded metadata size and Keccak-256 hash.
- ac8d097: Added optional live zero-confirmation updates alongside normal event subscriptions for every event type. Included provisional Merkle block hashes for reconnect and reorg validation.

  Kept normal subscriptions available when advisory zero-confirmation updates lacked near-head state for a requested domain.

- fc8d983: Shared event reads across connections and confirmation policies within isolated agent and validator sources. Added bounded outbound queues, route-specific byte quotas, and queue metrics. Increased per-proxy connection limits to 500 messages and 2,000 validators while retaining per-IP and setup limits. Limited custom confirmations to 1,000 and agent custom subscriptions to 512 domains and a 10,000 domain-block budget.
- 6bbcc80: Shared message reader rollbacks were narrowed to rows with a fact the rollback can change, and gas payment buckets were capped per paying domain: the oldest and newest heights stay exact and the middle folds into one bucket, so a frontier inside a fold returns partial totals instead of a payment-baseline error.
- 174b9e8: Shared message reader failures were made non-disconnecting: a failed domain read backs off without failing subscribers, rollback-invalidated reads are retried, rollbacks only invalidate cached facts that read the rolled-back domain, facts still waiting for transaction rows are reread, unwanted reads are no longer cached as missing messages, delivery updates reach subscribers of other domains again, and projection errors send a per-message error frame to global streams.
- 16c12f5: Shared message reader follow-ups were applied: a rollback that removes facts without lowering a subscriber's frontier rechecks rows whose payment fold can shift, the global Explorer queue budget evicts the client that alone holds the most bytes, projections are cached per frontier key so interleaved policies keep sharing frames, and exposure no longer sticks on domains a subscriber does not follow.
- bd8bc87: The shared message reader was made cheaper per subscriber: identical frames are encoded once, retained history is trimmed to the lowest active frontier, and provisional exposure is pruned lazily and keyed on visible fact heights.
- 0778021: Shared message WebSocket head snapshots, event scans, and message enrichment across subscribers while preserving each subscriber's confirmation policy and rollback frames.

  Isolated invalid message facts and domain recovery failures, cancelled abandoned reads, bounded subscription history cost, and evicted the largest outbound backlog under shared queue pressure.

- dca8c32: Fixed shared event reader handoffs and confirmation handling when the chain head retreated. Paced canonical fanout and let eligible publications drain before disconnecting subscribers under queue or cache pressure.
- Updated dependencies [ce47020]
- Updated dependencies [4ce76cb]
- Updated dependencies [f32ac07]
- Updated dependencies [e927ec6]
  - @hyperlane-xyz/utils@46.0.0

## 0.1.3

### Patch Changes

- ff7a363: Added typed relayer diagnostics and paginated activity history to GraphQL and opt-in WebSocket updates. Added message-ID filters so clients can subscribe only to the messages they track.
- 9ef15ff: Added scraper WebSocket wake-ups configured through a single Secret Manager JSON map, retaining five-second HTTP polling for recovery, batching proxy head updates, and keeping endpoint credentials out of Helm values.
- Updated dependencies [aa84958]
- Updated dependencies [c520224]
  - @hyperlane-xyz/utils@45.2.0

## 0.1.2

### Patch Changes

- 9e61e65: Normalized legacy signed database domain IDs to canonical unsigned values on agent WebSocket streams.
- 7762855: Reduced WebSocket broadcast CPU by sharing encoded JSON across Explorer clients and live agent subscribers. Preserved text frames, per-subscriber cursor validation and gas-payment metadata, and outbound buffer limits.
- 28eda66: Removed the total historical WebSocket replay row limit so validators could replay large chain histories without row-limit disconnections. Removed the associated configuration and limit metric while retaining replay progress metrics and other resource limits.
- Updated dependencies [9a59116]
- Updated dependencies [28eda66]
- Updated dependencies [4e2ab65]
  - @hyperlane-xyz/utils@45.0.0

## 0.1.1

### Patch Changes

- Updated dependencies [6fbe5ad]
  - @hyperlane-xyz/utils@44.0.0

## 0.1.0

### Minor Changes

- 7cf9c01: Added cursor pagination to scraper message queries. Message cursors must contain exactly one non-null `id`; `order_by` may be omitted, in which case the cursor direction determines the ordering.

  Added lightweight error, set, and validation utility subpath exports.

### Patch Changes

- Updated dependencies [7cf9c01]
  - @hyperlane-xyz/utils@43.0.0
