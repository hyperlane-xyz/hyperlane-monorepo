---
'@hyperlane-xyz/rebalancer': patch
---

Fixed inventory rebalancer to include tokenFeeQuote in transfer cost calculation, preventing UNPREDICTABLE_GAS_LIMIT failures when native token fees exceed tx gas costs.
