---
'@hyperlane-xyz/widgets': patch
---

Replace WebSocket-based `confirmTransaction` with HTTP polling (`getSignatureStatuses`) for Solana transaction confirmation. Fixes hangs with RPC providers that don't support `signatureSubscribe`.
