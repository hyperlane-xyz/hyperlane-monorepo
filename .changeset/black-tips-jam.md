---
"@hyperlane-xyz/core": minor
---

The Blacklist ISM contract is added to support owner-controlled message ID blocking. Blacklisted IDs are stored in an enumerable set, exposing a `values()` getter so the full blacklist can be read on-chain and off-chain. Entries are append-only and permanent.
