---
'@hyperlane-xyz/core': major
'@hyperlane-xyz/sdk': minor
---

Renamed `maxFeeBps` to `maxFeePpm` on `TokenBridgeCctpV2` to accurately reflect the parts-per-million denomination. The on-chain getter, setter, event, and storage slot were all renamed. SDK handles both old (`maxFeeBps()`) and new (`maxFeePpm()`) contract interfaces via version-gated calls.
