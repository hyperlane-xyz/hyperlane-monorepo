---
'@hyperlane-xyz/cli': patch
---

`hyperlane status` no longer requires private keys when checking message status. Keys are now only required when using `--relay` flag, and only for the destination chain protocol you're relaying to.
