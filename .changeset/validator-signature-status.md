---
"@hyperlane-xyz/sdk": minor
---

Added real-time validator signature status to MetadataBuilder. The builder now returns detailed information about which validators have signed a message, their checkpoint indices, and actual signatures. Also includes significant performance optimizations: EvmIsmReader routing ISM derivation reduced from ~5.7s to ~724ms via messageContext short-circuit, and SmartProvider retry logic fixed to correctly identify permanent errors.
