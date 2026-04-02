---
'@hyperlane-xyz/tron-sdk': patch
---

TronJsonRpcProvider was changed to extend `StaticJsonRpcProvider` with a `detectNetwork` fallback and default `estimateGas` override for Tron's unreliable RPC methods. Automatic `/jsonrpc` suffix appending was removed — callers now pass the correct URL directly. TronWallet now parses `custom_rpc_header` query params from RPC URLs and forwards them as headers to TronWeb HTTP API calls (needed for TronGrid API key auth). `alterTransaction` was switched to `txLocal: true` to avoid unnecessary network roundtrips.
