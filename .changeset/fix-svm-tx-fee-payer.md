---
"@hyperlane-xyz/sealevel-sdk": patch
---

Fixed serialized transaction output using the local keypair as fee payer instead of the actual authority (e.g. Squads vault). Added explicit feePayer field to SvmTransaction and set it on all update paths. Refactored IGP instruction builders to accept Address instead of TransactionSigner so the on-chain owner is used in serialized transactions.
