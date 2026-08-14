---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': minor
---

Support was added for Blacklist ISM deployments that predate on-chain enumeration.

- `EvmIsmReader` now probes `blacklistedIds(bytes32)` and `values()` separately, so a deployment without `values()` is derived as a `blacklistIsm` rather than falling through to `testIsm`.
- Enumeration was shared by the reader and `moduleMatchesConfig` through `readBlacklistedIds`, so both reached the same verdict for the same deployment. When `values()` was unavailable, the set was replayed from `MessageBlacklisted` logs, de-duplicated and sorted; entries are append-only, so a complete log sequence defined the current set.
- Reading was made to fail on detectable incompleteness rather than yielding a known partial set, since a Blacklist ISM config without its entries did not describe the deployment it named. Successful explorer and RPC responses continued to be trusted to describe the exact ranges requested. A deployment that had never blacklisted anything was read as an empty set, which remained a result and not a failure.
- Explorer-backed `getLogs` calls were made to page to completion or fail over without returning a prefix, and RPC deployment-block discovery was made to fail rather than start an infeasible scan from genesis when historical state was unavailable.
- `EvmIsmModule` redeploys a fresh Blacklist ISM instead of appending in place when the deployed one predates on-chain enumeration, so entries are never appended to a contract that is being phased out.
- Blacklist ISM and Test ISM config checks no longer accept a deployment purely on its module type. A Blacklist ISM config is checked against `blacklistedIds(bytes32)` before its entries are read, and a Test ISM config is confirmed by deriving the deployed module rather than matching any address whose module type is NULL. A deployment that cannot be shown to be one of those two configured types is now reported as a mismatch instead of passing. Checks for other ISM types are unchanged.
- `TestLegacyBlacklistIsm` was added as a test fixture reproducing the pre-audit contract, renamed from `BlacklistIsm` and compiled with a raised `>=0.8.18` pragma for its named mapping parameters; it is otherwise unchanged.
