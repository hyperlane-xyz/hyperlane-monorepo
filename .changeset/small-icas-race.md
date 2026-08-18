---
"@hyperlane-xyz/ccip-server": patch
"@hyperlane-xyz/sdk": patch
---

Interchain account address derivation was moved into the shared SDK path, with router metadata reads parallelized and modern addresses derived locally. This reduced the valid modern path from three sequential RPC rounds to one.
