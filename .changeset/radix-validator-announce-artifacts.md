---
'@hyperlane-xyz/radix-sdk': minor
---

Implemented validator announce artifact manager, reader, and writer for Radix SDK. Combined query and transaction functions in a unified validator-announce.ts file. RadixValidatorAnnounceArtifactManager provides read and create capabilities for validator announce deployments. The reader fetches the mailbox address from chain, and the writer creates new validator announce contracts (immutable, no update operations). Includes comprehensive e2e test coverage.
