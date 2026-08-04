---
"@hyperlane-xyz/core": patch
---

AbstractOffchainQuoter.submitQuote was updated to reject standing quotes with future-dated issuedAt, preventing a compromised signer from permanently locking the monotonic issuedAt barrier near uint48 max with an indefinite expiry (HL-2026Q2-001). A later legitimate quote can always overwrite by having a strictly larger issuedAt at submission time. Transient quotes (expiry == issuedAt) are unaffected.
