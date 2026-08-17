---
'@hyperlane-xyz/sdk': patch
---

EVM event reads were made resilient by trying each compatible configured block explorer before falling back to RPC.
