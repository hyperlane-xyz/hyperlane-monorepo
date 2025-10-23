---
"@hyperlane-xyz/sdk": minor
---

Introduced new SvmTransactionSigner interface, rewrite SvmMultiprotocolSignerAdapter to leverage this interface. Add more robust tx sending and handling to SvmMultiprotocolSignerAdapter. Implement KeypairSvmTransactionSigner to handle the general PK/keypair-based tx signing.
