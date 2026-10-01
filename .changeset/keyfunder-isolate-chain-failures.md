---
'@hyperlane-xyz/keyfunder': patch
---

The key-funder job no longer fails when only some chains fail to fund. It fails only when every chain fails, and records per-chain results in the new `hyperlane_keyfunder_chain_funding_success` metric.
