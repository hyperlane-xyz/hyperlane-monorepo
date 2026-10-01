---
'@hyperlane-xyz/sealevel-sdk': major
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/provider-sdk': minor
---

Added `SealevelRoutingMessageIdMultisigIsmReader`, `SealevelRoutingMessageIdMultisigIsmWriter` and `SealevelRoutingMessageIdMultisigIsmWriterConfig` to the Sealevel SDK, which read and write a message-id multisig ISM holding an independent validator set and threshold per origin domain. The writer enforces per-domain caps of 24 validators and a threshold of 8 when writing a domain (on create, and for added or changed domains on update, not for unchanged on-chain domains), and the reader and writer take a non-empty list of candidate domain ids. They replace `SealevelMessageIdMultisigIsmReader`, `SealevelMessageIdMultisigIsmWriter` and `SealevelMultisigIsmConfig`, which were removed. The multisig ISM instruction builders now take `Address` owners.

`NonEmptyArray`, `nonEmptyArray` and `isNonEmptyArray` were added to `@hyperlane-xyz/utils`. `@hyperlane-xyz/provider-sdk/ism` exports `DomainMultisigConfig` and `RoutingMessageIdMultisigIsmArtifactConfig`.
