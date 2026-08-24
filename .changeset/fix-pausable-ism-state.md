---
'@hyperlane-xyz/sdk': patch
---

Pausable ISMs now respect the configured `paused` state. Signer-owned changes are applied directly; all others are returned as transactions.
