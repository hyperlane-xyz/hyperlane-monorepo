---
'@hyperlane-xyz/sdk': minor
---

An optional `blockTag` parameter was added to `readBlacklistedIds` to read a Blacklist ISM's blacklisted IDs as of that block rather than the latest one. It was passed to `values()`, and the log replay for deployments that predate on-chain enumeration stopped at that block, with a named tag such as `finalized` resolved to its block number first. A deployment the explorer reported as made after that block read as an empty set.
