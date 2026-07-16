---
"@hyperlane-xyz/sdk": patch
---

`HyperlaneJsonRpcProvider` no longer treats a bare `"0x"` `eth_call` result as an invalid provider response. Unlike `eth_getBalance`/`eth_getBlock`/`eth_getBlockNumber` (JSON-RPC `QUANTITY` types, where a spec-compliant zero is `"0x0"`), `eth_call`'s result is a `DATA` type, and `"0x"` is the correct, common response for a call that reverts with no reason string or targets an address with no code. Previously this was misclassified as a broken provider, which caused `SmartProvider` to exhaust all RPCs and throw a generic "All providers failed" error instead of surfacing a normal `CALL_EXCEPTION` — this in turn broke `EvmHookReader`'s legacy-IGP detection (`quoteSigners()` probe), causing `warp read`/`warp check` to fail entirely on routes with a legacy (pre-v2) `InterchainGasPaymaster` behind an aggregation hook.
