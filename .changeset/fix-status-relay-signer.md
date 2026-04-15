---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cli': patch
---

Fixed `deliver()` and `sendMessage()` in HyperlaneCore to connect the mailbox with the current signer at call time, preventing "sending a transaction requires a signer" errors when signers are added after construction. The `status --relay` command now exits non-zero when relay fails.
