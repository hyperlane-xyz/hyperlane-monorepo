# @hyperlane-xyz/scraper-proxy

## 0.2.0

### Minor Changes

- 63228b2: Removed historical agent WebSocket backfills, replay cursors, catch-up frames and metrics, and the subscription metric's state label. Limited agent frames to 64 KiB and documented per-type, mid-range live starts and the required RPC overlap.

  Required deployment of the validator and relayer RPC-recovery refactors (#10038 and #10039), or explicit RPC-only configuration for older agents, before the proxy upgrade. Accepted the metrics compatibility break; the single affected dashboard will be updated separately. Kept public endpoint exposure and the central snapshot service as separate follow-ups.

### Patch Changes

- ac8d097: Added optional live zero-confirmation updates alongside normal event subscriptions for every event type. Included provisional Merkle block hashes for reconnect and reorg validation.

  Kept normal subscriptions available when advisory zero-confirmation updates lacked near-head state for a requested domain.

- Updated dependencies [f32ac07]
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
