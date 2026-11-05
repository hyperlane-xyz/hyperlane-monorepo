---
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/infra": patch
"@hyperlane-xyz/scraper-proxy": patch
---

Added scraper WebSocket wake-ups configured through a single Secret Manager JSON map, retaining five-second HTTP polling for recovery, batching proxy head updates, and keeping endpoint credentials out of Helm values.
