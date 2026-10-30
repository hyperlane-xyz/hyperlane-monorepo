---
'@hyperlane-xyz/core': patch
---

- A `WormholeVaaHookIsm` custom consistency level requires an allowed base level and a nonzero number of additional blocks.
- The Wormhole commitment includes the custom base level and additional blocks of the publishing hook, and verification compares them with the values enrolled for the remote route.
- The expected consistency level of a remote route is checked against the levels a VAA can carry: the local allowlist plus the Solana values `1` and `32`.
