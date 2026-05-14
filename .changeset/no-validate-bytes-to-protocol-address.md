---
"@hyperlane-xyz/utils": patch
---

`bytesToProtocolAddress` no longer asserts that input bytes are non-zero. The function name describes a formatting operation, and decoders (explorer, CLI display, debug printouts) need to render stored zero-bytes addresses rather than throw. Zero-address rejection during transfer construction still happens at the inverse `addressToBytes` and at the WarpCore `validateRecipient` layer.
