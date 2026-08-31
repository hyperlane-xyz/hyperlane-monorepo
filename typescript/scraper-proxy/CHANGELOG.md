# @hyperlane-xyz/scraper-proxy

## 0.1.0

### Minor Changes

- 7cf9c01: Added cursor pagination to scraper message queries. Message cursors must contain exactly one non-null `id`; `order_by` may be omitted, in which case the cursor direction determines the ordering.

  Added lightweight error, set, and validation utility subpath exports.

### Patch Changes

- Updated dependencies [7cf9c01]
  - @hyperlane-xyz/utils@43.0.0
