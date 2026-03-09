---
'@hyperlane-xyz/relayer': patch
'@hyperlane-xyz/infra': patch
---

ccipread revert data extraction was hardened with BFS traversal, isRecord type guard, minimum 64-byte hex threshold, and iteration guard. Relay catch block now logs the error object. Governor SAFE retry was moved to per-batch level to prevent duplicate proposals, and errors are now re-thrown after logging.
