---
"@hyperlane-xyz/core": minor
---

Added a Wormhole hook and ISM. The WormholeHook publishes the Hyperlane message id to the Wormhole guardian network on dispatch, and the WormholeIsm verifies the resulting VAA (supplied as metadata) against the authorized emitter and message id before delivery.
