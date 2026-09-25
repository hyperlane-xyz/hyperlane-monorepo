# @hyperlane-xyz/scraper-proxy

## 0.1.2

### Patch Changes

- 9e61e65: Normalized legacy signed database domain IDs to canonical unsigned values on agent WebSocket streams.
- 7762855: Reduced WebSocket broadcast CPU by sharing encoded JSON across Explorer clients and live agent subscribers. Preserved text frames, per-subscriber cursor validation and gas-payment metadata, and outbound buffer limits.
- 28eda66: Removed the total historical WebSocket replay row limit so validators could replay large chain histories without row-limit disconnections. Removed the associated configuration and limit metric while retaining replay progress metrics and other resource limits.
- Updated dependencies [9a59116]
- Updated dependencies [28eda66]
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
