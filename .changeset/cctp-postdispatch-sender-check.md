---
'@hyperlane-xyz/core': patch
---

Added a sender check in CctpBase._postDispatch to prevent misuse when called via transferRemote.
