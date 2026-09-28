---
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/sealevel-sdk': patch
'@hyperlane-xyz/starknet-sdk': patch
---

Hook, ISM, and warp artifact manager dispatch was made explicitly partial through shared factory map types. Unsupported artifacts now throw structured errors containing the artifact type and protocol.
