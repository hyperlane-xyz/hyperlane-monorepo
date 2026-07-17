---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/sealevel-sdk": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/cli": minor
---

`hyperlane core apply` was extended to upgrade the Sealevel mailbox program. A new optional `contractVersion` field was added to `MailboxArtifactConfig` (cross-VM) and `CoreConfigSchema` and threaded through the writer stack: `SvmMailboxReader.read` populated it from the on-chain `GetProgramVersion` instruction, `SvmMailboxWriter.update` ran `prepareProgramUpgrade` as the first step when an upgrade was needed, and the deploy-sdk `CoreWriter` / `CoreArtifactReader` forwarded the field through the `update` path. The `create` path deliberately did not forward it, so a fresh deploy installed whatever binary the SDK bundled rather than triggering a program upgrade mid-deploy. `EvmCoreReader.deriveCoreConfig` populated `contractVersion` from `Mailbox.PACKAGE_VERSION()` so the field round-tripped through `core read` for EVM as well as Sealevel. The EVM sentinel-version logic that was duplicated across `EvmCoreReader`, `EvmWarpRouteReader`, and `EvmTokenAdapter` was extracted into a shared `fetchPackageVersion` helper and `LEGACY_PACKAGE_VERSION` constant in the sdk's `utils/contract`. The svm-sdk's three per-program version fetchers (warp / IGP / mailbox) were unified behind a single shared internal `queryProgramVersionWithOwnerFallback` helper; the helper adopted warp's throw-on-fallback-failure semantic so real RPC errors were no longer masked as pre-versioned programs. Localnet test suites airdropped the (still-exported) `FALLBACK_SIMULATION_PAYER` in their `before()` to keep production-style reads (owners with no SOL) working in tests.
