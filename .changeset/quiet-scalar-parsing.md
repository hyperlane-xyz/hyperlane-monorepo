---
"@hyperlane-xyz/aleo-sdk": patch
"@hyperlane-xyz/cli": patch
"@hyperlane-xyz/cosmos-sdk": patch
"@hyperlane-xyz/metrics": patch
"@hyperlane-xyz/radix-sdk": patch
"@hyperlane-xyz/rebalancer": patch
"@hyperlane-xyz/relayer": patch
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/starknet-sdk": patch
"@hyperlane-xyz/sealevel-sdk": patch
"@hyperlane-xyz/tron-sdk": patch
"@hyperlane-xyz/utils": patch
"@hyperlane-xyz/warp-widget": patch
---

Invariant regular expressions were reused across calls, redundant URL parsing was removed from RPC-header and explorer helpers, and independent token reads were overlapped with bounded concurrency and failure draining. URL normalization, validation, and dependent read ordering were preserved.
