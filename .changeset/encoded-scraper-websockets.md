---
'@hyperlane-xyz/scraper-proxy': patch
---

Reduced WebSocket broadcast CPU by sharing encoded JSON across Explorer clients and live agent subscribers. Preserved text frames, per-subscriber cursor validation and gas-payment metadata, and outbound buffer limits.
