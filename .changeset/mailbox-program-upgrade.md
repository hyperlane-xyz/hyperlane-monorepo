---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/sealevel-sdk": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/cli": minor
---

`hyperlane core apply` is extended to upgrade the Sealevel mailbox program. A new optional `contractVersion` field was added to `MailboxArtifactConfig` (cross-VM) and `CoreConfigSchema` and threaded through the writer stack: `SvmMailboxReader.read` populates it from the on-chain `GetProgramVersion` instruction, `SvmMailboxWriter.update` runs `prepareProgramUpgrade` as the first step when an upgrade is needed, and the deploy-sdk `CoreWriter` / `CoreArtifactReader` forward the field across both `create` and `update` paths. `EvmCoreReader.deriveCoreConfig` populates `contractVersion` from `Mailbox.PACKAGE_VERSION()` so the field round-trips through `core read` for EVM as well as Sealevel. The svm-sdk's three per-program version fetchers (warp / IGP / mailbox) were unified behind a single shared internal `queryProgramVersionWithOwnerFallback` helper; the helper adopts warp's throw-on-fallback-failure semantic so real RPC errors are no longer masked as pre-versioned programs. Localnet test suites airdrop the (still-exported) `FALLBACK_SIMULATION_PAYER` in their `before()` to keep production-style reads (owners with no SOL) working in tests.
