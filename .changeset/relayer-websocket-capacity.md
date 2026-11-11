---
'@hyperlane-xyz/infra': patch
---

Increased the mainnet scraper-proxy connection limit to accommodate per-origin relayer WebSockets alongside validators, with deployment headroom. The capacity check was corrected to count each relayer origin, including shadow subscriptions.
