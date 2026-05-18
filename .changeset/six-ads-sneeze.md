---
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
---

Enabled warp send for Aleo. When Aleo is the origin chain, the CLI now skips delivery confirmation (message ID extraction from Aleo receipts is not yet supported) instead of throwing an error.
