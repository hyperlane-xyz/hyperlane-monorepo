---
"@hyperlane-xyz/fee-quoting": minor
---

The SVM quote service was changed to substitute the user-supplied `recipient` with `WILDCARD_RECIPIENT` (`0xff × 32`) when signing standing-mode warp quotes — transient mode is unchanged. SVM standing quotes are stored at a PDA keyed by `(fee_account, dest_domain, target_router)` with no recipient in the seeds, so signing the user's actual recipient partitioned the standing PDA per recipient and prevented reuse. The on-chain consume handler already has a wildcard-recipient fallback (fee program `processor/quote.rs`) that accepts the substituted value, so standing quotes became universally consumable as designed. EVM behavior is unchanged — EVM quotes are recipient-bound by the wrapper contract's exec-time verification, not by a PDA lookup, so the substitution doesn't apply there.
