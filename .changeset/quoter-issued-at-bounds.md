---
"@hyperlane-xyz/core": patch
---

AbstractOffchainQuoter.submitQuote was updated to reject standing quotes with future-dated issuedAt and to bound their lifetime by MAX_STANDING_TTL (7 days), preventing a compromised signer from permanently locking the monotonic issuedAt barrier with an indefinite expiry (HL-2026Q2-001). Transient quotes (expiry == issuedAt) are unaffected.
