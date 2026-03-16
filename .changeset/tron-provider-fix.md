---
'@hyperlane-xyz/tron-sdk': patch
---

TronJsonRpcProvider was changed to extend `StaticJsonRpcProvider` with a `detectNetwork` fallback and default `estimateGas` override for Tron's unreliable RPC methods. Automatic `/jsonrpc` suffix appending was removed — callers now pass the correct URL directly. TronWallet falls back to public TronGrid for TronWeb operations when using third-party JSON-RPC providers.
