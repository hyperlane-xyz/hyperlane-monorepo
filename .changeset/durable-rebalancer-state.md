---
'@hyperlane-xyz/rebalancer': patch
---

Durable rebalancer state was added so source-started transfers remain suppressed
across restarts and ambiguous send failures. Delivered transfers were removed
immediately, while terminal intent groups were retained for seven days.
