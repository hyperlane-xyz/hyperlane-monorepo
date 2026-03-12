---
'@hyperlane-xyz/radix-sdk': minor
---

Implemented mailbox artifact manager, reader, and writer for Radix SDK. RadixMailboxArtifactManager provides read and create/update capabilities for mailbox deployments. The reader fetches mailbox configuration from chain including owner, defaultIsm, defaultHook, and requiredHook. The writer supports creating new mailboxes with initial configuration and updating existing mailboxes by comparing state and generating update transactions.
