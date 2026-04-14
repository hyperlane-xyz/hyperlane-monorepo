---
'@hyperlane-xyz/widgets': patch
---

Replaced WebSocket-based `confirmTransaction` with HTTP polling (`getSignatureStatuses`) for Solana transaction confirmation. Fixed hangs with RPC providers that don't support `signatureSubscribe`.
