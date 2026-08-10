---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': minor
---

Support was added for Blacklist ISM deployments that predate on-chain enumeration.

- `EvmIsmReader` now probes `blacklistedIds(bytes32)` and `values()` separately, so a deployment without `values()` is derived as a `blacklistIsm` rather than falling through to `testIsm`.
- Enumeration is shared by the reader and `moduleMatchesConfig` through `readBlacklistedIds`, so both reach the same verdict for the same deployment. When `values()` is unavailable, the set is replayed from `MessageBlacklisted` logs, de-duplicated and sorted; entries are append-only, so the replay is exact.
- Reading fails when the set cannot be established, rather than yielding a partial one, since a Blacklist ISM config without its entries does not describe the deployment it names. A deployment that has never blacklisted anything reads as an empty set, which is a result and not a failure.
- `EvmIsmModule` redeploys a fresh Blacklist ISM instead of appending in place when the deployed one predates on-chain enumeration, so entries are never appended to a contract that is being phased out.
- Blacklist ISM and Test ISM config checks no longer accept a deployment purely on its module type. A Blacklist ISM config is checked against `blacklistedIds(bytes32)` before its entries are read, and a Test ISM config is confirmed by deriving the deployed module rather than matching any address whose module type is NULL. A deployment that cannot be shown to be one of those two configured types is now reported as a mismatch instead of passing. Checks for other ISM types are unchanged.
- `TestLegacyBlacklistIsm` was added as a test fixture reproducing the pre-audit contract, renamed from `BlacklistIsm` and compiled with a raised `>=0.8.18` pragma for its named mapping parameters; it is otherwise unchanged.
