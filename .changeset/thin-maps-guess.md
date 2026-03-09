---
'@hyperlane-xyz/cli': patch
---

The `status` command resolved all EVM chains instead of only the origin/destination chains, causing crashes when unrelated chains had bad RPCs. Chain resolution was narrowed to only explicitly provided chains, with destination chains from the dispatch tx getting signers lazily via `ensureEvmSignersForChains`.
