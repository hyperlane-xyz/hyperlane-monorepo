---
'@hyperlane-xyz/sdk': patch
---

Seismic signed reads and gas estimates retained connected-provider RPC fallback, custom connections, and the explicit RPC URL for offline or non-RPC signers. Client initialization was reused while replay protection remained fresh, and decrypted reverts were exposed as ethers-compatible errors. Authenticated reads retained explicit failures for unsupported signers.

Added `HyperlaneSmartProvider.sendReadRpc`, `ProviderMethod.ReadRpc`, and `ReadRpcMethods` for bounded raw reads without advertising a general JSON-RPC `send` method.
