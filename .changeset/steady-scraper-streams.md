---
'@hyperlane-xyz/scraper-proxy': patch
---

Fixed shared event reader handoffs and confirmation handling when the chain head retreated. Paced canonical fanout and let eligible publications drain before disconnecting subscribers under queue or cache pressure.
