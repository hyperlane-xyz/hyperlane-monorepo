---
'@hyperlane-xyz/rebalancer': patch
---

The positional warp config override was preserved when external bridge API keys were added. Completed swaps.xyz responses without amount data were rejected instead of reporting zero, with source reservations retained for subsequent reconciliation.
