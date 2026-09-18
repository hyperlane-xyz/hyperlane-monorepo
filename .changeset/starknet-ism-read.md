---
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/starknet-sdk': patch
---

Fixed Starknet core reads that mislabeled unsupported ISMs as test ISMs. Added read support for aggregation trees and pausable ISMs, preserved their nested configuration and pause state, and rejected unknown modules instead of reporting them as accept-all ISMs.
