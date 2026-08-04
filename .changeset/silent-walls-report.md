---
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/relayer": patch
---

Added SDK support for the Blacklist ISM:

- Blacklist ISM configs can now be deployed, derived from on-chain state (including the full list of blacklisted message IDs) and matched against existing deployments using exact set equality.
- Updates that only add message IDs are applied in-place by submitting a single `blacklist` transaction with the missing IDs.
- Updates that drop a currently blacklisted message ID redeploy a fresh ISM, since on-chain entries are append-only and cannot be removed.
- Blacklisted message IDs are validated as 32-byte hex strings and normalized to lowercase at config parse time.
- The relayer now treats the blacklist ISM as a null-metadata ISM when building message metadata.
- `moduleCanCertainlyVerify` reports that a Blacklist ISM cannot certainly verify a message whose ID is in the blacklisted set.
- Blacklist ISM configs are validated at parse time to require a mandatory composition: they must be a member of an aggregation whose threshold equals its module count, and are rejected when used standalone, as a routing target, or under a non-exhaustive aggregation.
