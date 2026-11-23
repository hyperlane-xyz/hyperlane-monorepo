---
'@hyperlane-xyz/rebalancer': minor
---

The swaps.xyz executor was changed to validate provider-agnostic response bounds and simulate arbitrary provider payloads without requiring provider-specific calldata decoding. Pending status variants were accepted without weakening route-identity checks, and refreshed exact-output quotes were bounded by the configured quote-loss limit.
