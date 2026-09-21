---
'@hyperlane-xyz/scraper-proxy': patch
---

Removed the total historical WebSocket replay row limit so validators could replay large chain histories without row-limit disconnections. Removed the associated configuration and limit metric while retaining replay progress metrics and other resource limits.
