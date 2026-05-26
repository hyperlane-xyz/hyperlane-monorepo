---
"@hyperlane-xyz/sealevel-sdk": minor
---

Added `buildBeneficiaryAtaIx` to `instructions/fee.ts`. Returns an idempotent create-Associated-Token-Account instruction for `(beneficiary, feeToken)` (or null for native / no-asset flows). Shared helper used by the fee writers' beneficiary-update path and the warp writers' create path.
