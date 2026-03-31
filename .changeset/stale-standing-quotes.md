---
"@hyperlane-xyz/core": patch
---

Standing quote staleness logic was lifted into `AbstractOffchainQuoter._checkStaleQuote`. Strictly older quotes revert with `StaleQuote`, equal `issuedAt` quotes are silently skipped, and newer quotes are stored with event emission.
