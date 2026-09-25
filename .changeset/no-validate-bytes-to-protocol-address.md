---
"@hyperlane-xyz/utils": patch
---

Removed the zero-byte assertion from `bytesToProtocolAddress`. The function name describes a formatting operation, and decoders (explorer, CLI display, debug printouts) needed to render stored zero-byte addresses rather than throw. Zero-address rejection during transfer construction remained enforced at `addressToBytes` and at `WarpCore.validateRecipient`.
