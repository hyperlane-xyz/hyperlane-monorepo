---
'@hyperlane-xyz/cli': patch
---

Signer initialization is now deferred until after interactive chain selection for the `send message` command. This improves startup performance by only creating signers for the chains that will actually be used, rather than all EVM chains upfront.
