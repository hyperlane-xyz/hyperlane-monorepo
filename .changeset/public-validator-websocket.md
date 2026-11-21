---
'@hyperlane-xyz/scraper-proxy': minor
---

Added a public, live-only /validators WebSocket for single-domain Merkle insertions with optional confirmation counts, shared readers, bounded admission, and usage metrics. Validator-only reads were isolated from the internal live pool. Deployment requires a supporting proxy image before switching validator images and endpoint URLs.
