---
'@hyperlane-xyz/scraper-proxy': patch
---

Added optional live zero-confirmation updates alongside normal event subscriptions for every event type. Included provisional Merkle block hashes for reconnect and reorg validation.

Kept normal subscriptions available when advisory zero-confirmation updates lacked near-head state for a requested domain.
