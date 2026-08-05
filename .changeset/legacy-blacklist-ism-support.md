---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': minor
---

Support was added for Blacklist ISM deployments that predate on-chain enumeration.

- `EvmIsmReader` now probes `blacklistedIds(bytes32)` and `values()` separately, so a deployment without `values()` is derived as a `blacklistIsm` rather than falling through to `testIsm`.
- Enumeration is shared by the reader and `moduleMatchesConfig` through `readBlacklistedIds`, so both reach the same verdict for the same deployment. When `values()` is unavailable, the set is replayed from `MessageBlacklisted` logs via `EvmEventLogsReader`, de-duplicated and sorted; entries are append-only, so the replay is exact. When the logs cannot be read, or fill an explorer page and so cannot be proven complete, the set is reported as unknown instead of empty or partial.
- `blacklistedIds` is now optional on `BlacklistIsmConfig` to represent an unknown set. `moduleCanCertainlyVerify` and `moduleMatchesConfig` both report `false` when the set is unknown, and `moduleMatchesConfig` no longer throws against a deployment without `values()`.
- `EvmIsmModule` redeploys a fresh Blacklist ISM instead of appending in place when the deployed one predates on-chain enumeration, and `HyperlaneIsmFactory` refuses to deploy a Blacklist ISM whose `blacklistedIds` are absent, so an unknown set can never be written back as an empty one.
- `TestLegacyBlacklistIsm` was added as a test fixture reproducing the pre-audit contract.
