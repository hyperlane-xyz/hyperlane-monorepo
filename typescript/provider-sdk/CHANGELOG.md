# @hyperlane-xyz/provider-sdk

## 7.2.0

### Minor Changes

- 961a89d: Two new CLI commands for managing offchain-signed warp fee quotes were added: `hyperlane warp quote create` submits a standing signed quote (`--ttl` in seconds, must be > 0) against a deployed `OffchainQuotedLinearFee` leaf on EVM or SVM, and `hyperlane warp quote read` enumerates the standing quotes stored on every supported chain in a warp route (or a single `--chain`), with an optional `--recipients` array to additionally probe non-router recipient addresses on protocols with non-enumerable storage (EVM). Output renders bytes32 sentinels (`TARGET_ROUTER_NONE`, `DEFAULT_CROSS_COLLATERAL_ROUTER`, `WILDCARD_RECIPIENT`) as labels with ISO timestamps and an `expired` flag. The CLI bridges EVM and AltVM via a single `factories.ts` switch (EVM doesn't implement `ProtocolProvider`), shared by both commands. Underneath, `@hyperlane-xyz/sdk` adds `EvmQuoteArtifactManager` / `EvmQuoteWriter` / `EvmQuoteReader` / `EvmPrivateKeyQuoteSigner` against the EIP-712 typed-data layout plus a `buildFeeReadContextFromWarpDeployConfig` helper that bypasses AltVM token-type validation; `@hyperlane-xyz/sealevel-sdk` adds the equivalent `SvmQuote*` surface against the SVM fee-program's `SubmitQuote` instruction and exports `resolveFeeSalt`; `@hyperlane-xyz/provider-sdk` defines the cross-VM interfaces (`IRawWarpQuoteArtifactManager`, `RawQuoteSigner`, `enumerateWarpQuoteCandidates`, `ReadStandingQuotesOpts`). For cross-collateral routes, `warp quote create` resolves the target router leaf from the destination's `remoteRouters` then `crossCollateralRouters` then the DEFAULT fallback, and accepts a `--target-router` override (destination-native address) to target a specific router-keyed leaf. `--quote-signer-key` also reads from the `HYP_QUOTE_SIGNER_KEY` env var, and a standing-quote submission that is an on-chain no-op (an equal-or-newer quote already exists) now warns instead of reporting success.

### Patch Changes

- @hyperlane-xyz/utils@38.0.0

## 7.1.0

### Minor Changes

- df34a68: TS SDK and CLI support was added for the Sealevel-only Composite ISM program (`hyperlane-sealevel-composite-ism`), a single program that stores an entire ISM tree — `TrustedRelayer`, `MultisigMessageId`, `Aggregation`, `Test`, `Pausable`, `AmountRouting`, `RateLimited`, `Routing`, and `FallbackRouting` nodes — in one PDA, in place of the many separately-deployed ISM contracts EVM uses. `hyperlane core`/`hyperlane warp` `deploy`/`apply`/`read`/`check` now work with a `compositeIsm` config the same as any other ISM type, config-file (YAML/JSON) input only.

  `@hyperlane-xyz/sdk` gained `IsmType.COMPOSITE` and a recursive `CompositeIsmNodeConfigSchema`/`CompositeIsmConfigSchema` mirroring the Rust CLI's config-file representation one-to-one; sub-nodes are inline Borsh data, not separate deployments, so only `routing`/`fallbackRouting.domains` (chain-name keyed, config-file-only) get diffed into per-domain instructions. The `ModuleType` enum was also fixed to use explicit values and gained `OP_L2_TO_L1`, `POLYMER`, and `COMPOSITE` members — it was previously auto-numbered and had silently drifted out of sync with `IInterchainSecurityModule.sol`'s enum, a pre-existing bug found while adding `COMPOSITE`.

  `@hyperlane-xyz/provider-sdk` gained the Artifact-API mirror of the composite ISM tree (domain-ID keyed), a `mergeIsmArtifacts` branch that treats `compositeIsm` as self-diffing (skips the generic Artifact recursion since sub-nodes aren't independently addressed), and recursive chain-name/domain-ID conversion in `ismConfigToArtifact`/`ismArtifactToDerivedConfig`.

  `@hyperlane-xyz/sealevel-sdk` gained the bulk of the new code: a hand-rolled Borsh codec for `IsmNode`/`CompositeIsmStorage`/`DomainIsmStorage` verified byte-for-byte against the Rust program's own serialization, PDA derivation for the shared VAM storage seed and per-domain seed, instruction builders for all seven mutating instructions, `SvmCompositeIsmReader`/`Writer`, a `detectIsmType()` probe, and the compiled program bytes embedded via the existing `program:build`/`program:generate` pipeline. `SvmCompositeIsmWriter.create()`'s `Initialize` call now passes `skipPreflight: true`, matching `SvmTestIsmWriter`'s existing workaround for a solana-test-validator race where preflight simulation can reject a just-deployed program with "Unsupported program id". A new `composite-ism.e2e-test.ts` exercises create/read, root updates, pause/unpause, ownership transfer, and routing-domain diffing end-to-end against a real local validator.

  `@hyperlane-xyz/deploy-sdk` registered `compositeIsm` as a supported, mutable ISM type and wired its writer's `update()` into the generic `IsmWriter`.

- cc4bdb6: `hyperlane core apply` was extended to upgrade the Sealevel mailbox program. A new optional `contractVersion` field was added to `MailboxArtifactConfig` (cross-VM) and `CoreConfigSchema` and threaded through the writer stack: `SvmMailboxReader.read` populated it from the on-chain `GetProgramVersion` instruction, `SvmMailboxWriter.update` ran `prepareProgramUpgrade` as the first step when an upgrade was needed, and the deploy-sdk `CoreWriter` / `CoreArtifactReader` forwarded the field through the `update` path. The `create` path deliberately did not forward it, so a fresh deploy installed whatever binary the SDK bundled rather than triggering a program upgrade mid-deploy. `EvmCoreReader.deriveCoreConfig` populated `contractVersion` from `Mailbox.PACKAGE_VERSION()` so the field round-tripped through `core read` for EVM as well as Sealevel. The EVM sentinel-version logic that was duplicated across `EvmCoreReader`, `EvmWarpRouteReader`, and `EvmTokenAdapter` was extracted into a shared `fetchPackageVersion` helper and `LEGACY_PACKAGE_VERSION` constant in the sdk's `utils/contract`. The svm-sdk's three per-program version fetchers (warp / IGP / mailbox) were unified behind a single shared internal `queryProgramVersionWithOwnerFallback` helper; the helper adopted warp's throw-on-fallback-failure semantic so real RPC errors were no longer masked as pre-versioned programs. Localnet test suites airdropped the (still-exported) `FALLBACK_SIMULATION_PAYER` in their `before()` to keep production-style reads (owners with no SOL) working in tests.
- 31f8b51: Added cross-VM plumbing for the warp orchestrator to thread a warp route's settlement asset into its paired fee config at deploy and update time:
  - `BaseFeeConfig` and `SyntheticWarpArtifactConfig` gained an optional `token` field, populated by the SVM synthetic warp reader/writer with the adapter-deployed mint PDA.
  - The deploy-sdk warp orchestrator deployed the warp first and then the fee with the resolved settlement asset, attaching it via the existing update path so per-asset setup (notably SVM beneficiary ATA creation via the new `buildBeneficiaryAtaIx`) ran against the now-known mint.
  - SVM leaf-fee readers returned params in bps shape with raw values carried alongside, and `shouldDeployNewFee` was rewritten around a semantic params comparison so apply/enroll round-trips no longer spuriously redeployed the fee.
  - The SVM fee writers only emitted a standalone beneficiary-ATA-create transaction when the ATA did not already exist on-chain (via the new `beneficiaryAtaExists` helper), so a no-op update converged to zero transactions and a fee-bearing deploy no longer force-sent an owner-signed ATA transaction through the deployer signer.
  - `computeRemoteRoutersUpdates` kept the current on-chain destination gas for an existing router when the expected config omitted it (and defaulted to `'0'` for new routers), instead of zeroing it.
  - The altVM branch of `executeWarpDeploy` deployed each warp as the deployer signer (intermediate owner), mirroring the EVM deployer, so post-deploy cross-chain router enrollment stayed authorized by the deployer key and ownership was handed to the configured owner during enrollment.

### Patch Changes

- 97e8ca1: SVM IGP fee config integration was added to the SVM SDK. SvmIgpHookReader was updated to surface the on-chain Igp.fee_config (signers + domainId + minIssuedAt) via the new feeConfig field on SvmDeployedIgpHook, and to expose the signer list through provider-sdk's IgpHookConfig.quoteSigners. SvmIgpHookWriter.create() and update() were updated to reconcile the multi-VM quoteSigners shape with on-chain state, mirroring EVM IGP semantics (undefined ⇒ leave on-chain state untouched, [] ⇒ keep fee_config Some without signers, [...] ⇒ initialize and/or Add/Remove diff). Clearing fee_config to None was intentionally left out of the declarative diff. The writer was wired to version-gate against the program's GetProgramVersion response (post-upgrade version when an upgrade fires in the same update) and to reject domain_id drift.

  Breaking change: SvmIgpHookWriterConfig was extended to require domainId, and SvmHookArtifactManager (exported as SealevelHookArtifactManager) was updated to take domainId as a required second constructor argument. SvmProtocolProvider was updated to thread chainMetadata.domainId through automatically, mirroring SvmMailboxConfig and SvmValidatorAnnounceConfig. The IGP program upgrade flow was wired through the writer using the existing prepareProgramUpgrade helper, hoisted out of warp/ into a shared deploy/program-upgrade.ts.

  Low-level codecs and instruction builders for the seven new IGP fee instructions were added: SetIgpQuoteConfig, SetIgpQuoteSigner, SetIgpMinIssuedAt, SubmitIgpQuote, CloseIgpTransientQuote, CloseIgpStandingQuote, and GetIgpQuoteAccountMetas. The IgpFeeConfig codec, IgpStandingQuote / IgpTransientQuote account decoders, the corresponding standing- and transient-quote PDA derivers, and WILDCARD_SENDER / WILDCARD_DOMAIN constants were promoted to public exports. SvmSignedQuote and GetIgpQuoteAccountMetasInput codecs were added with full encode/decode round-trip coverage.

  The provider-sdk IgpHookConfig was extended with optional contractVersion and quoteSigners fields, mirroring the EVM IgpSchema. Several previously private helpers were promoted to shared homes to support the new code without duplication: readAddress / readOptionAddress / ascii8 were moved into codecs/account-data.ts, and decodeBTreeSetH160 / decodeSetQuoteSignerOperation were colocated with the existing encoders in codecs/fee.ts. The svm-sdk unit-test runner glob was widened to src/\*_/_.unit-test.ts to pick up colocated codec / hook tests.

  The CLI gained `hyperlane hook deploy`, `hyperlane hook read`, and `hyperlane hook apply` commands, working across EVM and Alt-VM chains (including Sealevel IGP hooks with the fee config above). The shared read/parse/validate logic was extracted into a validateAndParseHookConfig helper so deploy and apply cannot drift, and the deploy path's config parse-error message was unified to lowercase "Invalid hook config".
  - @hyperlane-xyz/utils@37.0.0

## 7.0.0

### Major Changes

- aa41ce4: SVM fee program management was added to the SVM SDK with full create, read, and update support for all 6 fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting). The provider-sdk fee types were refactored with a FeeParams discriminated union (bps vs raw), PascalCase FeeType/FeeStrategyType values, expanded DerivedFeeConfig with resolved bigint fields, and a required FeeReadContext parameter on createFeeArtifactManager. Shared BPS fee utilities (computeBps, bpsToRawFeeParams, constants) were consolidated into provider-sdk as the single source of truth — sdk and svm-sdk now import from provider-sdk. The EVM SDK TokenFeeType was converted from enum to const object for structural compatibility. Legacy pre-fee program bytes were preserved for upgrade testing. The repeated account-decoding boilerplate in the fee and token decoders was consolidated into a shared decodeDiscriminatedAccount helper.

### Minor Changes

- 2f9d783: CLI warp deploy and warp apply commands were wired to drive SVM fee program lifecycles. A new tokenFeeInputToFeeConfig mapping was added to bridge EVM SDK fee config inputs to provider-sdk fee types, and tokenFee was plumbed through validateWarpConfigForAltVM so YAML configs flow into the multi-VM deploy/update path. The fee config input schema gained an optional beneficiary field so operators can set a beneficiary distinct from the owner; tokenFeeInputToFeeConfig now respects it (defaulting to owner when omitted) instead of forcing beneficiary = owner. tokenFeeInputToFeeConfig also now prefers raw maxFee/halfAmount over the schema's derived bps when both are present, so YAML configs authored as raw round-trip without silent bps conversion. The four SVM fee writers were switched to deploy programs with exact-byte-length data accounts (matching the warp token writer convention), halving the rent paid for each fee program. SvmWarpArtifactManager is now publicly exported from sealevel-sdk. provider-sdk now exports `DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY` from `@hyperlane-xyz/provider-sdk/warp` for downstream CLI/test code that needs to reference the wildcard cross-collateral target-router slot without depending on the main SDK.

### Patch Changes

- 9bdab1d: SVM warp route fee integration was added. Warp token writers wired SetFeeConfig into the create and update flows with fee PDA validation, and readers were updated to surface the on-chain fee config. The token account decoder was extended to read the trailing Option<FeeConfig> field. Program version detection was added via GetProgramVersion simulation, gating explicit program upgrades that emit ExtendProgramChecked and Upgrade against the deployed BPF Loader v3 program. A contractVersion field was added to the provider-sdk warp config types, and compare-versions was promoted to the workspace catalog.
- Updated dependencies [9cd7606]
  - @hyperlane-xyz/utils@36.0.0

## 6.1.1

### Patch Changes

- @hyperlane-xyz/utils@35.2.0

## 6.1.0

### Minor Changes

- d1b6f0a: Added new hook deploy command

### Patch Changes

- @hyperlane-xyz/utils@35.1.0

## 6.0.4

### Patch Changes

- Updated dependencies [da1cfb1]
  - @hyperlane-xyz/utils@35.0.1

## 6.0.3

### Patch Changes

- @hyperlane-xyz/utils@35.0.0

## 6.0.2

### Patch Changes

- @hyperlane-xyz/utils@34.0.0

## 6.0.1

### Patch Changes

- @hyperlane-xyz/utils@33.1.1

## 6.0.0

### Major Changes

- bfe4d2e: Breaking: the `./protocol` subpath no longer re-exports `ProtocolType`, `ProtocolTypeValue`, or `ProtocolSmallestUnit`. These were moved to the new `./protocolType` module to break an import cycle. Import them from the main `@hyperlane-xyz/provider-sdk` entry instead.

### Patch Changes

- @hyperlane-xyz/utils@33.1.0

## 5.1.0

### Minor Changes

- b864cca: Multi-VM fee type support was added to provider-sdk and deploy-sdk. Fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting) were defined with Config API and Artifact API variants. FeeReader and FeeWriter with required FeeReadContext were added to deploy-sdk. Fee was integrated into warp types and the warp writer update flow. All protocol providers received createFeeArtifactManager stubs.

### Patch Changes

- Updated dependencies [1f918d0]
  - @hyperlane-xyz/utils@33.0.2

## 5.0.3

### Patch Changes

- @hyperlane-xyz/utils@33.0.1

## 5.0.2

### Patch Changes

- @hyperlane-xyz/utils@33.0.0

## 5.0.1

### Patch Changes

- @hyperlane-xyz/utils@32.0.1

## 5.0.0

### Major Changes

- 3dc6367: Core query methods (getIsmType, getRoutingIsm, getHookType, etc.) were removed from the IProvider interface and extracted into standalone query functions in each SDK. isMessageDelivered was kept on the interface to enforce all providers implement it.

  Starknet get\*Transaction methods were extracted into standalone tx builder functions (mailbox-tx.ts, ism-tx.ts, hook-tx.ts, warp-tx.ts) with their own parameter types, removing the dependency on provider-sdk Req/Res types.

  Tron and Aleo providers and signers had all get\*Transaction and action methods removed. Old e2e tests replaced with artifact API equivalents.

  76 Req/Res types were removed from provider-sdk altvm.ts, reducing it from 587 to 243 lines.

- fa08f2a: IProvider and ISigner interfaces were slimmed to their minimal surface. IProvider was reduced from 53 to 22 query-only methods by removing all get\*Transaction methods. ISigner was reduced from 36 to 5 infrastructure methods by removing all action methods (createMailbox, setDefaultIsm, enrollRemoteRouter, etc.). Transaction building is now handled exclusively by artifact managers using concrete class methods or standalone helper functions.

  Throwing stubs were removed from SVM, Cosmos, Radix, and Starknet provider/signer implementations. Old action-method-based e2e tests were replaced with artifact API equivalents. Cosmos routing ISM writer was fixed to handle domain route updates correctly via remove + re-add.

### Patch Changes

- @hyperlane-xyz/utils@32.0.0

## 4.3.4

### Patch Changes

- @hyperlane-xyz/utils@31.2.1

## 4.3.3

### Patch Changes

- @hyperlane-xyz/utils@31.2.0

## 4.3.2

### Patch Changes

- @hyperlane-xyz/utils@31.1.0

## 4.3.1

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1

## 4.3.0

### Minor Changes

- 44626fb: Enabled SVM cross-collateral token deployments in the CLI. Added `crossCollateral` to supported Alt-VM token types, allowing `warp deploy`, `warp combine`, and `warp apply` to work with SVM CC routes. Extracted `computeCrossCollateralRouterUpdates` into provider-sdk for cross-protocol reuse. Fixed CC-only gas preservation for domains transitioning from remote routers.

### Patch Changes

- @hyperlane-xyz/utils@31.0.0

## 4.2.5

### Patch Changes

- @hyperlane-xyz/utils@30.1.1

## 4.2.4

### Patch Changes

- @hyperlane-xyz/utils@30.1.0

## 4.2.3

### Patch Changes

- 37255ba: Starknet AltVM follow-up behavior was fixed across the CLI toolchain. Warp apply/update paths now preserve existing Starknet hook and ISM settings when config leaves them unset or uses empty addresses, zero-address hook and ISM references are normalized as unset during provider artifact conversion, and core mailbox bootstrap only passes through existing hook addresses for Starknet while other AltVMs keep zero-address placeholders.
- Updated dependencies [7646819]
  - @hyperlane-xyz/utils@30.0.0

## 4.2.2

### Patch Changes

- @hyperlane-xyz/utils@29.1.0

## 4.2.1

### Patch Changes

- @hyperlane-xyz/utils@29.0.1

## 4.2.0

### Patch Changes

- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [3c6b1ad]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/utils@29.0.0

## 4.1.0

### Minor Changes

- 5caac66: Added `crossCollateral` warp token type to the provider-sdk type system. All protocol SDK artifact managers were updated to handle the new type in their exhaustive switches.

### Patch Changes

- @hyperlane-xyz/utils@28.1.0

## 4.0.0

### Minor Changes

- 83767b9: Removed `AltVMCoreModule`, `AltVMCoreReader`, and `coreModuleProvider` from deploy-sdk in favor of the new core artifact API (`CoreWriter`, `createCoreReader`). Added `coreConfigToArtifact` and `coreResultToDeployedAddresses` helpers to provider-sdk. Updated CLI core deploy and read commands to use the new API.
- a6b7bf3: Added `toDeployedOrUndefined` utility and `UnsetArtifactAddress` type to the artifact module. Extended `ProtocolProvider` interface with `createMailboxArtifactManager` and `createValidatorAnnounceArtifactManager` methods. Updated `mailboxArtifactToDerivedCoreConfig` to handle UNDERIVED artifacts with zero addresses gracefully. Widened `DerivedCoreConfig` fields to accept `UnsetArtifactAddress`.

### Patch Changes

- @hyperlane-xyz/utils@28.0.0

## 3.1.0

### Minor Changes

- b892e61: Added mailbox and validator announce artifact interfaces in provider-sdk. The new interfaces establish the contract for mailbox and validator announce artifacts, including MailboxConfig with ISM and Hook artifact references, ValidatorAnnounceConfig with mailbox address reference, and raw artifact variants for protocol implementation use.
- b892e61: CoreArtifactReader was implemented as a composite artifact reader for core deployments. It takes a mailbox address and returns a fully expanded MailboxArtifactConfig with all nested ISM and hook artifacts read from chain. A backward-compatible deriveCoreConfig() method was provided. A mailboxArtifactToDerivedCoreConfig conversion helper was added to mailbox.ts and ismArtifactToDerivedConfig was exported from the ISM reader.

### Patch Changes

- Updated dependencies [b892e61]
  - @hyperlane-xyz/utils@27.1.0

## 3.0.1

### Patch Changes

- @hyperlane-xyz/utils@27.0.0

## 3.0.0

### Major Changes

- 1d116d8: Added Tron ProtocolType & deprecated Tron TechnicalStack. Add support for TronLink wallet in the widgets.

### Patch Changes

- Updated dependencies [06aacac]
- Updated dependencies [1d116d8]
  - @hyperlane-xyz/utils@26.0.0

## 2.0.0

### Major Changes

- 840fb33: Deprecated AltVM warp module classes were removed from deploy-sdk and replaced with the artifact API.

  deploy-sdk removed public exports:
  - AltVMWarpModule (use createWarpTokenWriter instead)
  - AltVMWarpRouteReader (use createWarpTokenReader instead)
  - AltVMDeployer (use createWarpTokenWriter per-chain instead)
  - warpModuleProvider (no longer needed)
  - ismConfigToArtifact (moved to @hyperlane-xyz/provider-sdk/ism)
  - shouldDeployNewIsm (moved to @hyperlane-xyz/provider-sdk/ism)

  provider-sdk breaking change: warpConfigToArtifact no longer accepts pre-built ismArtifact/hookArtifact parameters; ISM and hook conversion is now handled internally from the config.

  cosmos-sdk: name and symbol for warp tokens without on-chain metadata were changed from empty strings to 'Unknown'.

  CLI and SDK were updated to use the new artifact API via createWarpTokenWriter and createWarpTokenReader.

### Minor Changes

- e197331: Added WarpTokenReader and WarpTokenWriter for artifact API-based warp token operations.

  New exports:
  - createWarpTokenReader: Factory for reading warp tokens
  - createWarpTokenWriter: Factory for creating/updating warp tokens
  - WarpTokenReader: Artifact for reading warp tokens with nested ISM/hook expansion
  - WarpTokenWriter: Artifact for deploying and updating warp tokens

  Protocol providers now support createWarpArtifactManager method.

### Patch Changes

- @hyperlane-xyz/utils@25.5.0

## 1.4.1

### Patch Changes

- @hyperlane-xyz/utils@25.4.1

## 1.4.0

### Minor Changes

- 1f021bf: Implemented warp token artifact API for Radix. Added warp token artifact types to provider-sdk including `WarpArtifactConfig`, `RawWarpArtifactConfig`, and conversion functions between Config API and Artifact API formats. The artifact types support collateral and synthetic warp tokens with proper handling of nested ISM artifacts and domain ID conversions. Implemented Radix warp token readers and writers for both collateral and synthetic tokens, with artifact manager providing factory methods for type-specific operations. Writers support creating new warp tokens with ISM configuration, enrolling remote routers, and transferring ownership. Update operations generate transaction arrays for ISM changes, router enrollment/unenrollment, and ownership transfers. Native token type is not supported on Radix.

### Patch Changes

- Updated dependencies [1f021bf]
  - @hyperlane-xyz/utils@25.4.0

## 1.3.6

### Patch Changes

- @hyperlane-xyz/utils@25.3.2

## 1.3.5

### Patch Changes

- @hyperlane-xyz/utils@25.3.1

## 1.3.4

### Patch Changes

- @hyperlane-xyz/utils@25.3.0

## 1.3.3

### Patch Changes

- Updated dependencies [360db52]
- Updated dependencies [ccd638d]
  - @hyperlane-xyz/utils@25.2.0

## 1.3.2

### Patch Changes

- Updated dependencies [b930534]
  - @hyperlane-xyz/utils@25.1.0

## 1.3.1

### Patch Changes

- Updated dependencies [52ce778]
  - @hyperlane-xyz/utils@25.0.0

## 1.3.0

### Minor Changes

- 9dc71fe: Added forward-compatible enum validation to prevent SDK failures when the registry contains new enum values. Added `Unknown` variants to `ProtocolType`, `TokenType`, `IsmType`, `HookType`, `ExplorerFamily`, and `ChainTechnicalStack` enums. Exported `KnownProtocolType` and `DeployableTokenType` for type-safe mappings.

### Patch Changes

- Updated dependencies [57461b2]
- Updated dependencies [d580bb6]
- Updated dependencies [9dc71fe]
- Updated dependencies [bde05e9]
  - @hyperlane-xyz/utils@24.0.0

## 1.2.1

### Patch Changes

- 0b8c4ea: Fixed hook update logic for warp routes. The warp route reader now properly reads hook addresses from deployed contracts instead of hardcoding zero address. Hook update idempotency check fixed to use deepEquals with config normalization instead of reference equality, preventing unnecessary redeployments when applying identical configs. Aleo provider updated to handle null/zero hook addresses correctly. Protocol capability check added to restrict hook updates to Aleo only. Comprehensive test suite added covering hook type transitions (none→MerkleTree, MerkleTree→IGP, MerkleTree→none), IGP config updates (gas configs, beneficiary), and idempotency validation.
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
  - @hyperlane-xyz/utils@23.0.0

## 1.2.0

### Minor Changes

- 7f31d77: Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.

### Patch Changes

- Updated dependencies [66ef635]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
  - @hyperlane-xyz/utils@22.0.0

## 1.1.0

### Minor Changes

- 57a2053: Added optional gasPrice field to `TestChainMetadata` type

### Patch Changes

- @hyperlane-xyz/utils@21.1.0

## 1.0.0

### Minor Changes

- 239e1a1: Migrate AltVm JsonSubmittor and FileSubmittor to deploy-sdk (from provider-sdk and cli, respectively)
- ed10fc1: Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.

### Patch Changes

- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/utils@21.0.0

## 0.7.0

### Minor Changes

- 11fa887: Upgrade TypeScript from 5.3.3 to 5.8.3 and compilation target to ES2023
  - Upgraded TypeScript from 5.3.3 to 5.8.3 across all packages
  - Updated compilation target from ES2022 to ES2023 (Node 16+ fully supported)
  - Converted internal const enums to 'as const' pattern for better compatibility
  - Updated @types/node from ^18.14.5 to ^20.17.0 for TypeScript 5.7+ compatibility
  - Fixed JSON imports to use required 'with { type: "json" }' attribute (TS 5.7+ requirement)
  - No breaking changes to public API - all changes are internal or non-breaking

### Patch Changes

- Updated dependencies [11fa887]
  - @hyperlane-xyz/utils@20.1.0

## 0.6.0

### Minor Changes

- aeac943: Refactor AltVMJsonRpcTxSubmitter to implement ITransactionSubmitter. Remove ALT_VM_SUPPORTED_PROTOCOLS, createAltVMSubmitterFactories in favor of simplified getSubmitterByStrategy

### Patch Changes

- Updated dependencies [b3ebc08]
  - @hyperlane-xyz/utils@20.0.0

## 0.5.0

### Patch Changes

- @hyperlane-xyz/utils@19.13.0

## 0.4.0

### Minor Changes

- 38a1165c8: - Update CLI context `altVmSigners` to be a `ChainMap` instead of `AltVMSignerFactory`,
  - Update CLI context `altVmProviders` to be a `ChainMap` instead of `AltVMSignerFactory`.
  - Update all existing getter methods to use `mustTry`, instead of `assert`.
  - Delete `AltVMSupportedProtocols` and `AltVMProviderFactory`.
  - Move functions from `AltVMSignerFactory` to top-level functions.
  - Add `getMinGas` to Aleo, Cosmos and Radix ProtocolProvider.

### Patch Changes

- Updated dependencies [08cf7eca9]
- Updated dependencies [af2cd1729]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/utils@19.12.0

## 0.3.0

### Minor Changes

- dd6260eea: Added the gatewayUrls and packageAddress fields to the ChainMetadataForAltVM

### Patch Changes

- @hyperlane-xyz/utils@19.11.0

## 0.2.0

### Minor Changes

- a0ba5e2fb: created new packages for provider package restructure
- 66bed7126: migrated AltVm modules to provider-sdk and deploy-sdk
- f604423b9: - Remove AltVMProviderFactory to new API in deploy-sdk (loadlProtocolProviders) and Registry singleton.
  - Add `chainId` and `rpcUrls` to `ChainMetadataForAltVM`. Add `CosmosNativeProtocolProvider` and `RadixProtocolProvider` to both cosmos-sdk and radix-sdk, respectively.
  - Add `forWarpRead`, `forCoreRead`, and `forCoreCheck` to signerMiddleware to enable chain resolving for these CLI functions.
  - Add `assert` after some `altVmProvider.get` calls in SDK configUtils.

### Patch Changes

- Updated dependencies [aad2988c9]
- Updated dependencies [c2a64e8c5]
  - @hyperlane-xyz/utils@19.10.0
