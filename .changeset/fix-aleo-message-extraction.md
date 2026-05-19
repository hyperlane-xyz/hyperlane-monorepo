---
"@hyperlane-xyz/sdk": major
"@hyperlane-xyz/aleo-sdk": minor
"@hyperlane-xyz/cli": minor
---

The `extractMessageIds` method on `ICoreAdapter` is now async (returns `Promise`). Callers must add `await` at call sites.

`AleoCoreAdapter` now extracts message IDs using a tx-scoped approach: it matches BHP1024 `key_id` hashes from the transaction's finalize operations against precomputed mapping keys, then queries `dispatch_id_events` and `dispatch_events` for the message ID and destination chain. Unlike EVM/SVM adapters that parse receipt logs, Aleo extraction requires on-chain mapping queries. Callers constructing `MultiProtocolCore` for an Aleo origin chain must supply a real mailbox address (not a stub); passing no address causes extraction to return an empty result rather than throw.
