---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': minor
---

Support was added for Blacklist ISM deployments that predate on-chain enumeration.

- `EvmIsmReader` now probes `blacklistedIds(bytes32)` and `values()` separately, so a deployment without `values()` is derived as a `blacklistIsm` rather than falling through to `testIsm`.
- Enumeration is shared by the reader and `moduleMatchesConfig` through `readBlacklistedIds`, so both reach the same verdict for the same deployment. When `values()` is unavailable, the set is replayed from `MessageBlacklisted` logs via `EvmEventLogsReader`, de-duplicated and sorted; entries are append-only, so the replay is exact. When the logs cannot be read, or fill a block explorer page and so cannot be proven complete, the set is reported as unknown instead of empty or partial.
- `EvmEventLogsReader` gained `getLogsByTopicWithSource`, which reports whether the block explorer or the RPC served a request. `getLogsByTopic` is unchanged. Blacklist enumeration uses it to apply its page-cap check only to explorer responses, since the RPC path walks the whole block range in chunks and has no page cap.
- `blacklistedIds` is now optional on `BlacklistIsmConfig` to represent an unknown set. `moduleCanCertainlyVerify` and `moduleMatchesConfig` both report `false` when the set is unknown, and `moduleMatchesConfig` no longer throws against a deployment without `values()`.
- `EvmIsmModule` redeploys a fresh Blacklist ISM instead of appending in place when the deployed one predates on-chain enumeration, and `HyperlaneIsmFactory` refuses to deploy a Blacklist ISM whose `blacklistedIds` are absent, so an unknown set can never be written back as an empty one. `EvmIsmModule.update` now also rejects a caller-supplied target config whose Blacklist ISM omits `blacklistedIds`, which previously compared equal to an equally unknown deployed set and reported that no update was needed; the rejection names the offending node by its position in the config. A pinned address is left alone, since it asks for one specific deployment rather than for a set of entries.
- Blacklist ISM and Test ISM config checks no longer accept a deployment purely on its module type. A Blacklist ISM config is checked against `blacklistedIds(bytes32)` before its entries are read, and a Test ISM config is confirmed by deriving the deployed module rather than matching any address whose module type is NULL. A deployment that cannot be shown to be one of those two configured types is now reported as a mismatch instead of passing. Checks for other ISM types are unchanged.
- `TestLegacyBlacklistIsm` was added as a test fixture reproducing the pre-audit contract.
