---
"@hyperlane-xyz/sdk": patch
---

Fixed warp apply idempotency issue where re-running after partial failure would fail with UNPREDICTABLE_GAS_LIMIT error when ownership had already been transferred. The setFeeRecipient transaction is now only generated when the fee recipient actually needs to change.
