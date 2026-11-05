---
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/infra": patch
---

Added scraper WebSocket wake-ups configured through a single Secret Manager JSON map, retaining HTTP polling for recovery and keeping endpoint credentials out of Helm values.
