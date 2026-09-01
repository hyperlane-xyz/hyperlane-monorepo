---
'@hyperlane-xyz/core': minor
---

Wormhole hook/ISM router contracts were added:

- `AbstractWormholeHookIsm` now provides shared routing, publication, fee, and
  message-binding invariants for Wormhole integrations.
- `WormholeExecutorHookIsm` supports permissionless Executor VAA callbacks and
  delayed metadata-free verification.
- `WormholeVaaHookIsm` supports direct VAA verification through CCIP-read
  metadata.
- Both variants publish a Hyperlane-bound Wormhole envelope and can serve as a
  combined outbound hook and inbound ISM for a full remote-router mesh.
