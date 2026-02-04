---
'@hyperlane-xyz/rebalancer': patch
---

ActionTracker now uses MultiProtocolCore instead of HyperlaneCore for message delivery checks, enabling support for all VM types. Registry addresses are validated at startup to ensure mailbox is present.
