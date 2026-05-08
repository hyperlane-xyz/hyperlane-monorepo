---
'@hyperlane-xyz/sealevel-sdk': major
'@hyperlane-xyz/provider-sdk': patch
---

SVM IGP fee config integration was added to the SVM SDK. SvmIgpHookReader now surfaces the on-chain Igp.fee_config (signers + domainId + minIssuedAt) via the new feeConfig field on SvmDeployedIgpHook, and exposes the signer list through provider-sdk's IgpHookConfig.quoteSigners. SvmIgpHookWriter.update() reconciles the multi-VM quoteSigners shape with on-chain state (undefined ⇒ clear, [] ⇒ keep config without signers, [...] ⇒ Add/Remove diff), version-gates against the program's GetProgramVersion response (post-upgrade version when an upgrade fires in the same update), and rejects domain_id drift.

Breaking change: SvmIgpHookWriterConfig now requires domainId, and SvmHookArtifactManager (exported as SealevelHookArtifactManager) takes domainId as a required second constructor argument. SvmProtocolProvider threads chainMetadata.domainId through automatically, mirroring SvmMailboxConfig and SvmValidatorAnnounceConfig. The IGP program upgrade flow was wired through the writer using the existing prepareProgramUpgrade helper, hoisted out of warp/ into a shared deploy/program-upgrade.ts.

Low-level codecs and instruction builders for the seven new IGP fee instructions were added: SetIgpQuoteConfig, SetIgpQuoteSigner, SetIgpMinIssuedAt, SubmitIgpQuote, CloseIgpTransientQuote, CloseIgpStandingQuote, and GetIgpQuoteAccountMetas. The IgpFeeConfig codec, IgpStandingQuote / IgpTransientQuote account decoders, the corresponding standing- and transient-quote PDA derivers, and WILDCARD_SENDER / WILDCARD_DOMAIN constants are now publicly exported. SvmSignedQuote and GetIgpQuoteAccountMetasInput codecs were added with full encode/decode round-trip coverage.

The provider-sdk IgpHookConfig was extended with optional contractVersion and quoteSigners fields, mirroring the EVM IgpSchema. Several previously private helpers were promoted to shared homes to support the new code without duplication: readAddress / readOptionAddress / ascii8 moved into codecs/account-data.ts, and decodeBTreeSetH160 / decodeSetQuoteSignerOperation joined the existing encoders in codecs/fee.ts. The svm-sdk unit-test runner glob was widened to src/**/*.unit-test.ts so colocated codec / hook tests get picked up.
