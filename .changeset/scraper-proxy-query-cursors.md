---
'@hyperlane-xyz/scraper-proxy': minor
'@hyperlane-xyz/utils': patch
---

Added cursor pagination to scraper message queries. Message cursors must contain exactly one non-null `id`; `order_by` may be omitted, in which case the cursor direction determines the ordering.

Added lightweight error, set, and validation utility subpath exports.
