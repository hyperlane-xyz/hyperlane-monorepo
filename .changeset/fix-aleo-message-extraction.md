---
"@hyperlane-xyz/sdk": major
"@hyperlane-xyz/aleo-sdk": minor
"@hyperlane-xyz/cli": minor
---

`ICoreAdapter.extractMessageIds` was made async (returns `Promise`). Callers must add `await` at call sites.

`AleoCoreAdapter` extracted message IDs by querying on-chain mappings. Because Aleo's mailbox nonce counter is a single shared mapping entry, at most one dispatch is accepted per block; a confirmed transaction with type `"execute"` was the accepted dispatch, and the dispatched nonce is `mailbox.nonce - 1`. Unlike EVM/SVM adapters that parsed receipt logs, Aleo extraction required on-chain mapping queries. Callers constructing `MultiProtocolCore` for an Aleo origin chain had to supply a real mailbox address (not a stub); passing no address caused extraction to return an empty result rather than throw.

Aleo warp token writers (native, collateral, synthetic) verified that the mailbox is initialized before deploying warp tokens. Previously, running `warp deploy` against an uninitialized mailbox produced a cryptic "transaction rejected" error from the on-chain finalize assertion; now a clear error is thrown immediately.
