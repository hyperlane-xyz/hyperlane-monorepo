---
"@hyperlane-xyz/core": patch
---

Standing quote staleness behavior was refined: strictly older quotes still revert with `StaleQuote`, equal `issuedAt` quotes are now silently skipped (no revert, no storage update), and only newer quotes trigger storage writes and `QuoteSubmitted` event emission.
