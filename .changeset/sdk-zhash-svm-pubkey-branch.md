---
"@hyperlane-xyz/sdk": patch
---

`ZHash` now accepts real Solana pubkeys. The existing base58 branch only matched exactly 32 characters, but a 32-byte Solana pubkey base58-encodes to 43 chars (top byte < 58) or 44 chars (top byte ≥ 58). A new dedicated base58 branch covers that 43–44 char range so consumers can validate real SVM addresses through `ZHash`. Existing branches (EVM hex, the original 32-char base58, Cosmos bech32, Radix, Aleo) are unchanged.
