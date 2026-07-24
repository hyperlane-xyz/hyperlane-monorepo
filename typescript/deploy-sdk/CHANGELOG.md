# @hyperlane-xyz/deploy-sdk

## 8.0.0

### Patch Changes

- 6793396: Fixed SVM warp-route program upgrades failing transaction simulation on clusters where the `enable_extend_program_checked` feature gate is inactive (e.g. Solana mainnet-beta). `prepareProgramUpgrade` queried the feature gate and emitted the legacy `ExtendProgram` (variant 6) instruction when the checked variant was unavailable, and clamped the program-data extend up to the loader's 10240-byte minimum instead of requesting the exact deficit (which the loader rejects). Added a generic `isFeatureActive` gate checker and a `program-extend-upgrade` e2e that exercised the unchecked extend path end-to-end against a feature-deactivated validator.

  Fixed the extend and upgrade racing the same slot when a `warp apply` both bumped `contractVersion` and set a fee: the loader rejects an Upgrade in the slot its program-data was extended ("Program was deployed in this block already"), and a program is not invocable in the slot it is upgraded. A generic `waitForSlotAdvance` hint was added to `SvmTransaction` and honored in `SvmSigner.send` — it polls until the cluster slot advances past the confirmed transaction's slot before reporting the send done, so the next transaction executes in a strictly later slot. `prepareProgramUpgrade` set the hint on the extend and upgrade transactions, guaranteeing extend → upgrade → config each land in separate slots. The signer stayed protocol-generic (no upgrade-specific logic) and the transactions remained emitted for export/multisig flows.

  `SvmSigner.signAndSend` surfaced the on-chain program logs from a failed preflight simulation (logged at `error` before rethrowing) so a failed apply shows why the transaction reverted (e.g. insufficient lamports, custom program errors) instead of a bare "Transaction simulation failed". `AltVMJsonRpcSubmitter` logged each transaction's annotation at `info` while submitting, matching the EVM `MultiProvider.sendTransaction` output.

  `prepareProgramUpgrade` clamped the program-data extend down to the remaining account headroom when growing to the loader's 10240-byte minimum would exceed Solana's 10 MiB account-data limit — the loader permits a sub-minimum extend that consumes exactly the remaining space — and failed fast with a clear message only when the new binary cannot fit the account at all, instead of letting an over-cap request produce an opaque on-chain loader error. `transactionToPrintableJson` carried the `waitForSlotAdvance` sequencing hint into its exported JSON, so file/Squads flows — where an external executor signs and submits the extend, upgrade, and config transactions — retained the directive to wait for the cluster slot to advance past each hinted transaction's confirmation slot before submitting the next one.

- Updated dependencies [4ef1fde]
- Updated dependencies [6f61265]
- Updated dependencies [6793396]
- Updated dependencies [1a31d04]
  - @hyperlane-xyz/provider-sdk@8.0.0
  - @hyperlane-xyz/sealevel-sdk@39.0.0
  - @hyperlane-xyz/tron-sdk@24.0.0
  - @hyperlane-xyz/cosmos-sdk@39.0.0
  - @hyperlane-xyz/aleo-sdk@39.0.0
  - @hyperlane-xyz/radix-sdk@39.0.0
  - @hyperlane-xyz/starknet-sdk@29.0.0
  - @hyperlane-xyz/utils@39.0.0

## 7.2.0

### Patch Changes

- Updated dependencies [961a89d]
  - @hyperlane-xyz/sealevel-sdk@38.0.0
  - @hyperlane-xyz/provider-sdk@7.2.0
  - @hyperlane-xyz/aleo-sdk@38.0.0
  - @hyperlane-xyz/cosmos-sdk@38.0.0
  - @hyperlane-xyz/radix-sdk@38.0.0
  - @hyperlane-xyz/starknet-sdk@28.1.4
  - @hyperlane-xyz/tron-sdk@23.1.4
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

- Updated dependencies [df34a68]
- Updated dependencies [cc4bdb6]
- Updated dependencies [3771b2b]
- Updated dependencies [262073e]
- Updated dependencies [c4b3ff5]
- Updated dependencies [31f8b51]
- Updated dependencies [97e8ca1]
- Updated dependencies [5122e71]
- Updated dependencies [9c8b435]
  - @hyperlane-xyz/sealevel-sdk@37.0.0
  - @hyperlane-xyz/provider-sdk@7.1.0
  - @hyperlane-xyz/aleo-sdk@37.0.0
  - @hyperlane-xyz/cosmos-sdk@37.0.0
  - @hyperlane-xyz/radix-sdk@37.0.0
  - @hyperlane-xyz/starknet-sdk@28.1.3
  - @hyperlane-xyz/tron-sdk@23.1.3
  - @hyperlane-xyz/utils@37.0.0

## 7.0.0

### Major Changes

- aa41ce4: SVM fee program management was added to the SVM SDK with full create, read, and update support for all 6 fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting). The provider-sdk fee types were refactored with a FeeParams discriminated union (bps vs raw), PascalCase FeeType/FeeStrategyType values, expanded DerivedFeeConfig with resolved bigint fields, and a required FeeReadContext parameter on createFeeArtifactManager. Shared BPS fee utilities (computeBps, bpsToRawFeeParams, constants) were consolidated into provider-sdk as the single source of truth — sdk and svm-sdk now import from provider-sdk. The EVM SDK TokenFeeType was converted from enum to const object for structural compatibility. Legacy pre-fee program bytes were preserved for upgrade testing. The repeated account-decoding boilerplate in the fee and token decoders was consolidated into a shared decodeDiscriminatedAccount helper.

### Patch Changes

- Updated dependencies [9cd7606]
- Updated dependencies [aa41ce4]
- Updated dependencies [2f9d783]
- Updated dependencies [9bdab1d]
- Updated dependencies [5a5968f]
- Updated dependencies [823eca3]
- Updated dependencies [70586aa]
  - @hyperlane-xyz/utils@36.0.0
  - @hyperlane-xyz/provider-sdk@7.0.0
  - @hyperlane-xyz/sealevel-sdk@36.0.0
  - @hyperlane-xyz/aleo-sdk@36.0.0
  - @hyperlane-xyz/cosmos-sdk@36.0.0
  - @hyperlane-xyz/radix-sdk@36.0.0
  - @hyperlane-xyz/starknet-sdk@28.1.2
  - @hyperlane-xyz/tron-sdk@23.1.2

## 6.1.1

### Patch Changes

- @hyperlane-xyz/aleo-sdk@35.2.0
- @hyperlane-xyz/cosmos-sdk@35.2.0
- @hyperlane-xyz/radix-sdk@35.2.0
- @hyperlane-xyz/sealevel-sdk@35.2.0
- @hyperlane-xyz/utils@35.2.0
- @hyperlane-xyz/starknet-sdk@28.1.1
- @hyperlane-xyz/provider-sdk@6.1.1
- @hyperlane-xyz/tron-sdk@23.1.1

## 6.1.0

### Patch Changes

- Updated dependencies [d1b6f0a]
- Updated dependencies [a911f17]
  - @hyperlane-xyz/provider-sdk@6.1.0
  - @hyperlane-xyz/starknet-sdk@28.1.0
  - @hyperlane-xyz/cosmos-sdk@35.1.0
  - @hyperlane-xyz/radix-sdk@35.1.0
  - @hyperlane-xyz/aleo-sdk@35.1.0
  - @hyperlane-xyz/tron-sdk@23.1.0
  - @hyperlane-xyz/sealevel-sdk@35.1.0
  - @hyperlane-xyz/utils@35.1.0

## 6.0.4

### Patch Changes

- Updated dependencies [da1cfb1]
  - @hyperlane-xyz/utils@35.0.1
  - @hyperlane-xyz/aleo-sdk@35.0.1
  - @hyperlane-xyz/cosmos-sdk@35.0.1
  - @hyperlane-xyz/provider-sdk@6.0.4
  - @hyperlane-xyz/radix-sdk@35.0.1
  - @hyperlane-xyz/starknet-sdk@28.0.9
  - @hyperlane-xyz/sealevel-sdk@35.0.1
  - @hyperlane-xyz/tron-sdk@23.0.9

## 6.0.3

### Patch Changes

- Updated dependencies [631d7e7]
- Updated dependencies [f3851a3]
  - @hyperlane-xyz/aleo-sdk@35.0.0
  - @hyperlane-xyz/cosmos-sdk@35.0.0
  - @hyperlane-xyz/radix-sdk@35.0.0
  - @hyperlane-xyz/sealevel-sdk@35.0.0
  - @hyperlane-xyz/utils@35.0.0
  - @hyperlane-xyz/starknet-sdk@28.0.8
  - @hyperlane-xyz/provider-sdk@6.0.3
  - @hyperlane-xyz/tron-sdk@23.0.8

## 6.0.2

### Patch Changes

- Updated dependencies [9a1ce26]
  - @hyperlane-xyz/cosmos-sdk@34.0.0
  - @hyperlane-xyz/aleo-sdk@34.0.0
  - @hyperlane-xyz/radix-sdk@34.0.0
  - @hyperlane-xyz/sealevel-sdk@34.0.0
  - @hyperlane-xyz/utils@34.0.0
  - @hyperlane-xyz/starknet-sdk@28.0.7
  - @hyperlane-xyz/provider-sdk@6.0.2
  - @hyperlane-xyz/tron-sdk@23.0.7

## 6.0.1

### Patch Changes

- @hyperlane-xyz/aleo-sdk@33.1.1
- @hyperlane-xyz/cosmos-sdk@33.1.1
- @hyperlane-xyz/radix-sdk@33.1.1
- @hyperlane-xyz/sealevel-sdk@33.1.1
- @hyperlane-xyz/utils@33.1.1
- @hyperlane-xyz/starknet-sdk@28.0.6
- @hyperlane-xyz/provider-sdk@6.0.1
- @hyperlane-xyz/tron-sdk@23.0.6

## 6.0.0

### Patch Changes

- Updated dependencies [bfe4d2e]
  - @hyperlane-xyz/provider-sdk@6.0.0
  - @hyperlane-xyz/aleo-sdk@33.1.0
  - @hyperlane-xyz/cosmos-sdk@33.1.0
  - @hyperlane-xyz/radix-sdk@33.1.0
  - @hyperlane-xyz/starknet-sdk@28.0.5
  - @hyperlane-xyz/sealevel-sdk@33.1.0
  - @hyperlane-xyz/tron-sdk@23.0.5
  - @hyperlane-xyz/utils@33.1.0

## 5.1.0

### Minor Changes

- b864cca: Multi-VM fee type support was added to provider-sdk and deploy-sdk. Fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting) were defined with Config API and Artifact API variants. FeeReader and FeeWriter with required FeeReadContext were added to deploy-sdk. Fee was integrated into warp types and the warp writer update flow. All protocol providers received createFeeArtifactManager stubs.

### Patch Changes

- Updated dependencies [b864cca]
- Updated dependencies [1f918d0]
  - @hyperlane-xyz/provider-sdk@5.1.0
  - @hyperlane-xyz/sealevel-sdk@33.0.2
  - @hyperlane-xyz/cosmos-sdk@33.0.2
  - @hyperlane-xyz/radix-sdk@33.0.2
  - @hyperlane-xyz/starknet-sdk@28.0.4
  - @hyperlane-xyz/aleo-sdk@33.0.2
  - @hyperlane-xyz/tron-sdk@23.0.4
  - @hyperlane-xyz/utils@33.0.2

## 5.0.3

### Patch Changes

- @hyperlane-xyz/aleo-sdk@33.0.1
- @hyperlane-xyz/cosmos-sdk@33.0.1
- @hyperlane-xyz/radix-sdk@33.0.1
- @hyperlane-xyz/sealevel-sdk@33.0.1
- @hyperlane-xyz/utils@33.0.1
- @hyperlane-xyz/starknet-sdk@28.0.3
- @hyperlane-xyz/provider-sdk@5.0.3
- @hyperlane-xyz/tron-sdk@23.0.3

## 5.0.2

### Patch Changes

- @hyperlane-xyz/aleo-sdk@33.0.0
- @hyperlane-xyz/cosmos-sdk@33.0.0
- @hyperlane-xyz/radix-sdk@33.0.0
- @hyperlane-xyz/sealevel-sdk@33.0.0
- @hyperlane-xyz/utils@33.0.0
- @hyperlane-xyz/starknet-sdk@28.0.2
- @hyperlane-xyz/provider-sdk@5.0.2
- @hyperlane-xyz/tron-sdk@23.0.2

## 5.0.1

### Patch Changes

- @hyperlane-xyz/aleo-sdk@32.0.1
- @hyperlane-xyz/cosmos-sdk@32.0.1
- @hyperlane-xyz/radix-sdk@32.0.1
- @hyperlane-xyz/sealevel-sdk@32.0.1
- @hyperlane-xyz/utils@32.0.1
- @hyperlane-xyz/starknet-sdk@28.0.1
- @hyperlane-xyz/provider-sdk@5.0.1
- @hyperlane-xyz/tron-sdk@23.0.1

## 5.0.0

### Major Changes

- fa08f2a: IProvider and ISigner interfaces were slimmed to their minimal surface. IProvider was reduced from 53 to 22 query-only methods by removing all get\*Transaction methods. ISigner was reduced from 36 to 5 infrastructure methods by removing all action methods (createMailbox, setDefaultIsm, enrollRemoteRouter, etc.). Transaction building is now handled exclusively by artifact managers using concrete class methods or standalone helper functions.

  Throwing stubs were removed from SVM, Cosmos, Radix, and Starknet provider/signer implementations. Old action-method-based e2e tests were replaced with artifact API equivalents. Cosmos routing ISM writer was fixed to handle domain route updates correctly via remove + re-add.

### Patch Changes

- Updated dependencies [3dc6367]
- Updated dependencies [ab17263]
- Updated dependencies [fa08f2a]
  - @hyperlane-xyz/provider-sdk@5.0.0
  - @hyperlane-xyz/sealevel-sdk@32.0.0
  - @hyperlane-xyz/starknet-sdk@28.0.0
  - @hyperlane-xyz/aleo-sdk@32.0.0
  - @hyperlane-xyz/tron-sdk@23.0.0
  - @hyperlane-xyz/cosmos-sdk@32.0.0
  - @hyperlane-xyz/radix-sdk@32.0.0
  - @hyperlane-xyz/utils@32.0.0

## 4.3.4

### Patch Changes

- @hyperlane-xyz/aleo-sdk@31.2.1
- @hyperlane-xyz/cosmos-sdk@31.2.1
- @hyperlane-xyz/radix-sdk@31.2.1
- @hyperlane-xyz/sealevel-sdk@31.2.1
- @hyperlane-xyz/utils@31.2.1
- @hyperlane-xyz/starknet-sdk@27.2.10
- @hyperlane-xyz/provider-sdk@4.3.4
- @hyperlane-xyz/tron-sdk@22.1.14

## 4.3.3

### Patch Changes

- @hyperlane-xyz/aleo-sdk@31.2.0
- @hyperlane-xyz/cosmos-sdk@31.2.0
- @hyperlane-xyz/radix-sdk@31.2.0
- @hyperlane-xyz/sealevel-sdk@31.2.0
- @hyperlane-xyz/utils@31.2.0
- @hyperlane-xyz/starknet-sdk@27.2.9
- @hyperlane-xyz/provider-sdk@4.3.3
- @hyperlane-xyz/tron-sdk@22.1.13

## 4.3.2

### Patch Changes

- Updated dependencies [cf3f11c]
- Updated dependencies [8a082af]
  - @hyperlane-xyz/starknet-sdk@27.2.8
  - @hyperlane-xyz/aleo-sdk@31.1.0
  - @hyperlane-xyz/cosmos-sdk@31.1.0
  - @hyperlane-xyz/radix-sdk@31.1.0
  - @hyperlane-xyz/tron-sdk@22.1.12
  - @hyperlane-xyz/sealevel-sdk@31.1.0
  - @hyperlane-xyz/utils@31.1.0
  - @hyperlane-xyz/provider-sdk@4.3.2

## 4.3.1

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/aleo-sdk@31.0.1
  - @hyperlane-xyz/cosmos-sdk@31.0.1
  - @hyperlane-xyz/provider-sdk@4.3.1
  - @hyperlane-xyz/radix-sdk@31.0.1
  - @hyperlane-xyz/starknet-sdk@27.2.7
  - @hyperlane-xyz/sealevel-sdk@31.0.1
  - @hyperlane-xyz/tron-sdk@22.1.11

## 4.3.0

### Patch Changes

- Updated dependencies [44626fb]
- Updated dependencies [eaac4ab]
- Updated dependencies [1dac3b0]
  - @hyperlane-xyz/sealevel-sdk@31.0.0
  - @hyperlane-xyz/provider-sdk@4.3.0
  - @hyperlane-xyz/tron-sdk@22.1.10
  - @hyperlane-xyz/aleo-sdk@31.0.0
  - @hyperlane-xyz/cosmos-sdk@31.0.0
  - @hyperlane-xyz/radix-sdk@31.0.0
  - @hyperlane-xyz/starknet-sdk@27.2.6
  - @hyperlane-xyz/utils@31.0.0

## 4.2.5

### Patch Changes

- @hyperlane-xyz/aleo-sdk@30.1.1
- @hyperlane-xyz/cosmos-sdk@30.1.1
- @hyperlane-xyz/radix-sdk@30.1.1
- @hyperlane-xyz/sealevel-sdk@30.1.1
- @hyperlane-xyz/utils@30.1.1
- @hyperlane-xyz/starknet-sdk@27.2.5
- @hyperlane-xyz/provider-sdk@4.2.5
- @hyperlane-xyz/tron-sdk@22.1.9

## 4.2.4

### Patch Changes

- Updated dependencies [95c331e]
- Updated dependencies [b643062]
  - @hyperlane-xyz/sealevel-sdk@30.1.0
  - @hyperlane-xyz/tron-sdk@22.1.8
  - @hyperlane-xyz/aleo-sdk@30.1.0
  - @hyperlane-xyz/cosmos-sdk@30.1.0
  - @hyperlane-xyz/radix-sdk@30.1.0
  - @hyperlane-xyz/utils@30.1.0
  - @hyperlane-xyz/starknet-sdk@27.2.4
  - @hyperlane-xyz/provider-sdk@4.2.4

## 4.2.3

### Patch Changes

- 37255ba: Starknet AltVM follow-up behavior was fixed across the CLI toolchain. Warp apply/update paths now preserve existing Starknet hook and ISM settings when config leaves them unset or uses empty addresses, zero-address hook and ISM references are normalized as unset during provider artifact conversion, and core mailbox bootstrap only passes through existing hook addresses for Starknet while other AltVMs keep zero-address placeholders.
- Updated dependencies [516c829]
- Updated dependencies [37255ba]
- Updated dependencies [2a9b135]
- Updated dependencies [7646819]
  - @hyperlane-xyz/starknet-sdk@27.2.3
  - @hyperlane-xyz/provider-sdk@4.2.3
  - @hyperlane-xyz/sealevel-sdk@30.0.0
  - @hyperlane-xyz/utils@30.0.0
  - @hyperlane-xyz/tron-sdk@22.1.7
  - @hyperlane-xyz/aleo-sdk@30.0.0
  - @hyperlane-xyz/cosmos-sdk@30.0.0
  - @hyperlane-xyz/radix-sdk@30.0.0

## 4.2.2

### Patch Changes

- @hyperlane-xyz/aleo-sdk@29.1.0
- @hyperlane-xyz/cosmos-sdk@29.1.0
- @hyperlane-xyz/radix-sdk@29.1.0
- @hyperlane-xyz/sealevel-sdk@29.1.0
- @hyperlane-xyz/utils@29.1.0
- @hyperlane-xyz/starknet-sdk@27.2.2
- @hyperlane-xyz/provider-sdk@4.2.2
- @hyperlane-xyz/tron-sdk@22.1.6

## 4.2.1

### Patch Changes

- @hyperlane-xyz/aleo-sdk@29.0.1
- @hyperlane-xyz/cosmos-sdk@29.0.1
- @hyperlane-xyz/radix-sdk@29.0.1
- @hyperlane-xyz/sealevel-sdk@29.0.1
- @hyperlane-xyz/utils@29.0.1
- @hyperlane-xyz/starknet-sdk@27.2.1
- @hyperlane-xyz/provider-sdk@4.2.1
- @hyperlane-xyz/tron-sdk@22.1.5

## 4.2.0

### Minor Changes

- 09d6760: Added Starknet artifact API support across the TypeScript AltVM toolchain. The new `@hyperlane-xyz/starknet-sdk` package provides Starknet protocol, signer, provider, ISM, hook, mailbox, validator announce, and end-to-end test coverage. Deploy SDK protocol loading and the CLI context/signer flows were updated so Starknet chains can be resolved and used through the shared AltVM paths.

### Patch Changes

- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [3c6b1ad]
- Updated dependencies [09d6760]
- Updated dependencies [084c6b6]
- Updated dependencies [f0a33c6]
  - @hyperlane-xyz/tron-sdk@22.1.4
  - @hyperlane-xyz/utils@29.0.0
  - @hyperlane-xyz/starknet-sdk@27.2.0
  - @hyperlane-xyz/aleo-sdk@29.0.0
  - @hyperlane-xyz/cosmos-sdk@29.0.0
  - @hyperlane-xyz/provider-sdk@4.2.0
  - @hyperlane-xyz/radix-sdk@29.0.0
  - @hyperlane-xyz/sealevel-sdk@29.0.0

## 4.1.0

### Patch Changes

- Updated dependencies [5caac66]
- Updated dependencies [2e622e8]
  - @hyperlane-xyz/provider-sdk@4.1.0
  - @hyperlane-xyz/sealevel-sdk@28.1.0
  - @hyperlane-xyz/radix-sdk@28.1.0
  - @hyperlane-xyz/cosmos-sdk@28.1.0
  - @hyperlane-xyz/aleo-sdk@28.1.0
  - @hyperlane-xyz/tron-sdk@22.1.3
  - @hyperlane-xyz/utils@28.1.0

## 4.0.0

### Major Changes

- 83767b9: Removed `AltVMCoreModule`, `AltVMCoreReader`, and `coreModuleProvider` from deploy-sdk in favor of the new core artifact API (`CoreWriter`, `createCoreReader`). Added `coreConfigToArtifact` and `coreResultToDeployedAddresses` helpers to provider-sdk. Updated CLI core deploy and read commands to use the new API.

### Minor Changes

- a6b7bf3: Added `CoreWriter` and `CoreArtifactReader` for coordinating core deployments using the Artifact API pattern. The `CoreWriter` orchestrates mailbox, ISM, hook, and validator announce deployments with support for both create and update flows. Updated `AltVMCoreModule` to handle `UnsetArtifactAddress` in derived core configs.

### Patch Changes

- Updated dependencies [26d08de]
- Updated dependencies [83767b9]
- Updated dependencies [228ed9f]
- Updated dependencies [a6b7bf3]
  - @hyperlane-xyz/aleo-sdk@28.0.0
  - @hyperlane-xyz/provider-sdk@4.0.0
  - @hyperlane-xyz/cosmos-sdk@28.0.0
  - @hyperlane-xyz/radix-sdk@28.0.0
  - @hyperlane-xyz/sealevel-sdk@28.0.0
  - @hyperlane-xyz/tron-sdk@22.1.2
  - @hyperlane-xyz/utils@28.0.0

## 3.1.0

### Minor Changes

- b892e61: CoreArtifactReader was implemented as a composite artifact reader for core deployments. It takes a mailbox address and returns a fully expanded MailboxArtifactConfig with all nested ISM and hook artifacts read from chain. A backward-compatible deriveCoreConfig() method was provided. A mailboxArtifactToDerivedCoreConfig conversion helper was added to mailbox.ts and ismArtifactToDerivedConfig was exported from the ISM reader.

### Patch Changes

- abdbbf5: `createHookReader` accepted an optional mailbox context, which was threaded through `AltVMCoreReader` and `WarpTokenReader` for SVM merkle tree hook detection.
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
  - @hyperlane-xyz/provider-sdk@3.1.0
  - @hyperlane-xyz/radix-sdk@27.1.0
  - @hyperlane-xyz/utils@27.1.0
  - @hyperlane-xyz/aleo-sdk@27.1.0
  - @hyperlane-xyz/cosmos-sdk@27.1.0
  - @hyperlane-xyz/sealevel-sdk@27.1.0
  - @hyperlane-xyz/tron-sdk@22.1.1

## 3.0.1

### Patch Changes

- 22cb5cb: The `@hyperlane-xyz/sealevel-sdk` package (renamed from `@hyperlane-xyz/svm-sdk`) was published as a Solana/SVM client for Hyperlane Sealevel programs. It provides `SealevelProtocolProvider`, `SealevelProvider`, and `SealevelSigner` implementing the AltVM provider-sdk interfaces, along with warp token readers/writers (native, synthetic, collateral), ISM readers/writers (multisig message-ID, test), hook readers/writers (IGP, merkle tree), BPF program deployment/upgrade plans, PDA derivation utilities, and account decoders. ISM and hook deployment are not yet functional.

  `SealevelProtocolProvider` was registered in the deploy-sdk for `ProtocolType.Sealevel`, and `ProtocolType.Sealevel` was added to the CLI's supported protocols list, enabling `hyperlane warp deploy` for Solana chains.

- Updated dependencies [4a816e3]
- Updated dependencies [22cb5cb]
  - @hyperlane-xyz/tron-sdk@22.1.0
  - @hyperlane-xyz/sealevel-sdk@27.0.0
  - @hyperlane-xyz/aleo-sdk@27.0.0
  - @hyperlane-xyz/cosmos-sdk@27.0.0
  - @hyperlane-xyz/radix-sdk@27.0.0
  - @hyperlane-xyz/utils@27.0.0
  - @hyperlane-xyz/provider-sdk@3.0.1

## 3.0.0

### Patch Changes

- Updated dependencies [06aacac]
- Updated dependencies [1d116d8]
  - @hyperlane-xyz/utils@26.0.0
  - @hyperlane-xyz/provider-sdk@3.0.0
  - @hyperlane-xyz/tron-sdk@22.0.0
  - @hyperlane-xyz/aleo-sdk@26.0.0
  - @hyperlane-xyz/cosmos-sdk@26.0.0
  - @hyperlane-xyz/radix-sdk@26.0.0

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

- Updated dependencies [e197331]
- Updated dependencies [840fb33]
  - @hyperlane-xyz/provider-sdk@2.0.0
  - @hyperlane-xyz/aleo-sdk@25.5.0
  - @hyperlane-xyz/cosmos-sdk@25.5.0
  - @hyperlane-xyz/radix-sdk@25.5.0
  - @hyperlane-xyz/tron-sdk@21.1.5
  - @hyperlane-xyz/utils@25.5.0

## 1.4.1

### Patch Changes

- @hyperlane-xyz/aleo-sdk@25.4.1
- @hyperlane-xyz/cosmos-sdk@25.4.1
- @hyperlane-xyz/radix-sdk@25.4.1
- @hyperlane-xyz/utils@25.4.1
- @hyperlane-xyz/provider-sdk@1.4.1
- @hyperlane-xyz/tron-sdk@21.1.4

## 1.4.0

### Patch Changes

- Updated dependencies [1f021bf]
- Updated dependencies [1f021bf]
- Updated dependencies [1f021bf]
  - @hyperlane-xyz/aleo-sdk@25.4.0
  - @hyperlane-xyz/utils@25.4.0
  - @hyperlane-xyz/cosmos-sdk@25.4.0
  - @hyperlane-xyz/provider-sdk@1.4.0
  - @hyperlane-xyz/radix-sdk@25.4.0
  - @hyperlane-xyz/tron-sdk@21.1.3

## 1.3.6

### Patch Changes

- @hyperlane-xyz/tron-sdk@21.1.2
- @hyperlane-xyz/aleo-sdk@25.3.2
- @hyperlane-xyz/cosmos-sdk@25.3.2
- @hyperlane-xyz/radix-sdk@25.3.2
- @hyperlane-xyz/utils@25.3.2
- @hyperlane-xyz/provider-sdk@1.3.6

## 1.3.5

### Patch Changes

- Updated dependencies [7636bb4]
  - @hyperlane-xyz/tron-sdk@21.1.1
  - @hyperlane-xyz/aleo-sdk@25.3.1
  - @hyperlane-xyz/cosmos-sdk@25.3.1
  - @hyperlane-xyz/radix-sdk@25.3.1
  - @hyperlane-xyz/utils@25.3.1
  - @hyperlane-xyz/provider-sdk@1.3.5

## 1.3.4

### Patch Changes

- Updated dependencies [aea767c]
  - @hyperlane-xyz/tron-sdk@21.1.0
  - @hyperlane-xyz/aleo-sdk@25.3.0
  - @hyperlane-xyz/cosmos-sdk@25.3.0
  - @hyperlane-xyz/radix-sdk@25.3.0
  - @hyperlane-xyz/utils@25.3.0
  - @hyperlane-xyz/provider-sdk@1.3.4

## 1.3.3

### Patch Changes

- Updated dependencies [360db52]
- Updated dependencies [6091a31]
- Updated dependencies [ccd638d]
  - @hyperlane-xyz/utils@25.2.0
  - @hyperlane-xyz/aleo-sdk@25.2.0
  - @hyperlane-xyz/cosmos-sdk@25.2.0
  - @hyperlane-xyz/provider-sdk@1.3.3
  - @hyperlane-xyz/radix-sdk@25.2.0

## 1.3.2

### Patch Changes

- Updated dependencies [b930534]
- Updated dependencies [cbd400c]
  - @hyperlane-xyz/utils@25.1.0
  - @hyperlane-xyz/radix-sdk@25.1.0
  - @hyperlane-xyz/aleo-sdk@25.1.0
  - @hyperlane-xyz/cosmos-sdk@25.1.0
  - @hyperlane-xyz/provider-sdk@1.3.2

## 1.3.1

### Patch Changes

- Updated dependencies [52ce778]
  - @hyperlane-xyz/utils@25.0.0
  - @hyperlane-xyz/cosmos-sdk@25.0.0
  - @hyperlane-xyz/aleo-sdk@25.0.0
  - @hyperlane-xyz/provider-sdk@1.3.1
  - @hyperlane-xyz/radix-sdk@25.0.0

## 1.3.0

### Patch Changes

- 9c52a94: fix: replace error with debug log in altvm file submitter
- Updated dependencies [57461b2]
- Updated dependencies [d580bb6]
- Updated dependencies [b1b941e]
- Updated dependencies [9dc71fe]
- Updated dependencies [bde05e9]
  - @hyperlane-xyz/utils@24.0.0
  - @hyperlane-xyz/aleo-sdk@24.0.0
  - @hyperlane-xyz/provider-sdk@1.3.0
  - @hyperlane-xyz/cosmos-sdk@24.0.0
  - @hyperlane-xyz/radix-sdk@24.0.0

## 1.2.1

### Patch Changes

- 0b8c4ea: Fixed hook update logic for warp routes. The warp route reader now properly reads hook addresses from deployed contracts instead of hardcoding zero address. Hook update idempotency check fixed to use deepEquals with config normalization instead of reference equality, preventing unnecessary redeployments when applying identical configs. Aleo provider updated to handle null/zero hook addresses correctly. Protocol capability check added to restrict hook updates to Aleo only. Comprehensive test suite added covering hook type transitions (none→MerkleTree, MerkleTree→IGP, MerkleTree→none), IGP config updates (gas configs, beneficiary), and idempotency validation.
- Updated dependencies [c8f6f6c]
- Updated dependencies [0b8c4ea]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
- Updated dependencies [80f3635]
  - @hyperlane-xyz/aleo-sdk@23.0.0
  - @hyperlane-xyz/provider-sdk@1.2.1
  - @hyperlane-xyz/utils@23.0.0
  - @hyperlane-xyz/cosmos-sdk@23.0.0
  - @hyperlane-xyz/radix-sdk@23.0.0

## 1.2.0

### Minor Changes

- b0e9d48: Introduced artifact-based IsmWriter and migrated existing code to use it instead of AltVMIsmModule.
- 7f31d77: Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.

### Patch Changes

- Updated dependencies [ade2653]
- Updated dependencies [8b3f8da]
- Updated dependencies [0acaa0e]
- Updated dependencies [7f31d77]
- Updated dependencies [b0e9d48]
- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
- Updated dependencies [44fbfd6]
  - @hyperlane-xyz/aleo-sdk@22.0.0
  - @hyperlane-xyz/cosmos-sdk@22.0.0
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/provider-sdk@1.2.0
  - @hyperlane-xyz/radix-sdk@22.0.0

## 1.1.0

### Patch Changes

- Updated dependencies [db857b5]
- Updated dependencies [57a2053]
- Updated dependencies [57a2053]
- Updated dependencies [9c48ac8]
  - @hyperlane-xyz/cosmos-sdk@21.1.0
  - @hyperlane-xyz/provider-sdk@1.1.0
  - @hyperlane-xyz/aleo-sdk@21.1.0
  - @hyperlane-xyz/radix-sdk@21.1.0
  - @hyperlane-xyz/utils@21.1.0

## 1.0.0

### Major Changes

- 68310db: feat: aleo cli support

### Minor Changes

- 239e1a1: Migrate AltVm JsonSubmittor and FileSubmittor to deploy-sdk (from provider-sdk and cli, respectively)
- ed10fc1: Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.

### Patch Changes

- Updated dependencies [8006faf]
- Updated dependencies [68310db]
- Updated dependencies [239e1a1]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/aleo-sdk@21.0.0
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/radix-sdk@21.0.0
  - @hyperlane-xyz/cosmos-sdk@21.0.0
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
  - @hyperlane-xyz/cosmos-sdk@20.1.0
  - @hyperlane-xyz/radix-sdk@20.1.0
  - @hyperlane-xyz/provider-sdk@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [b3ebc08]
- Updated dependencies [aeac943]
  - @hyperlane-xyz/utils@20.0.0
  - @hyperlane-xyz/provider-sdk@0.6.0
  - @hyperlane-xyz/cosmos-sdk@20.0.0
  - @hyperlane-xyz/radix-sdk@20.0.0

## 0.5.0

### Minor Changes

- ae8ef4389: Fixed a bug in `AltVMHookModule` and `AltVMIsmModule` which prevented updates from an artifact type to a different one causing the update to fail

### Patch Changes

- Updated dependencies [ae8ef4389]
  - @hyperlane-xyz/radix-sdk@19.13.0
  - @hyperlane-xyz/cosmos-sdk@19.13.0
  - @hyperlane-xyz/utils@19.13.0
  - @hyperlane-xyz/provider-sdk@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [38a1165c8]
- Updated dependencies [08cf7eca9]
- Updated dependencies [af2cd1729]
- Updated dependencies [43b3756d9]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/provider-sdk@0.4.0
  - @hyperlane-xyz/cosmos-sdk@19.12.0
  - @hyperlane-xyz/radix-sdk@19.12.0
  - @hyperlane-xyz/utils@19.12.0

## 0.3.0

### Patch Changes

- Updated dependencies [dd6260eea]
- Updated dependencies [dd6260eea]
  - @hyperlane-xyz/provider-sdk@0.3.0
  - @hyperlane-xyz/radix-sdk@19.11.0
  - @hyperlane-xyz/cosmos-sdk@19.11.0
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

- aad2988c9: Export Logger type from utils for explicit typing in deploy-sdk
- Updated dependencies [aad2988c9]
- Updated dependencies [c2a64e8c5]
- Updated dependencies [a97a9939c]
- Updated dependencies [a0ba5e2fb]
- Updated dependencies [66bed7126]
- Updated dependencies [f604423b9]
  - @hyperlane-xyz/utils@19.10.0
  - @hyperlane-xyz/cosmos-sdk@19.10.0
  - @hyperlane-xyz/radix-sdk@19.10.0
  - @hyperlane-xyz/provider-sdk@0.2.0
