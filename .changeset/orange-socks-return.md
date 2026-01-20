---
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/provider-sdk': minor
---

CoreArtifactReader implemented as composite artifact reader for core deployments. Takes a mailbox address and returns fully expanded MailboxConfig with all nested ISM and hook artifacts read from chain. Provides backward-compatible deriveCoreConfig() method. Also adds mailboxArtifactToDerivedCoreConfig conversion helper to mailbox.ts and exports ismArtifactToDerivedConfig from ISM reader.
