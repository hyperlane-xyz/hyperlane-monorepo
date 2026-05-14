---
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/aleo-sdk": minor
---

Enabled warp send for Aleo. The `extractMessageIds` method on `ICoreAdapter` is now async. `AleoCoreAdapter` queries the mailbox's `dispatch_id_events` and `dispatch_events` mappings after a transfer to extract the message ID and destination chain.
