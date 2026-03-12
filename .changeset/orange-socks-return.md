---
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/provider-sdk': minor
---

CoreArtifactReader was implemented as a composite artifact reader for core deployments. It takes a mailbox address and returns a fully expanded MailboxArtifactConfig with all nested ISM and hook artifacts read from chain. A backward-compatible deriveCoreConfig() method was provided. A mailboxArtifactToDerivedCoreConfig conversion helper was added to mailbox.ts and ismArtifactToDerivedConfig was exported from the ISM reader.
