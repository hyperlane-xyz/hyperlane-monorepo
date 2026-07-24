# @hyperlane-xyz/sealevel-sdk

## 39.0.0

### Major Changes

- 4ef1fde: - `getMinGasForWarpDeploy` now lives on `IProvider` (per-chain) instead of the stateless `ProtocolProvider`. It is `async` and returns a FINAL native-denom amount rather than a mix of gas units and native amounts. It composes the base router deploy cost with additive deltas for detected features (cross-collateral extras, fee program deploy, custom ISM / hook / IGP deploy) driven by the warp config shape, and for gas-metered protocols multiplies gas units by the chain gas price.
  - `ChainMetadataForAltVM` gained an optional `gasPrice` field.
  - `ProviderBuilderFn` now takes a full `ChainMetadata` instead of `(rpcUrls, network)`.
  - The AltVM `IProvider.connect` and `ISigner.connectWithSigner` static factories now take `ChainMetadataForAltVM` as their first argument, replacing the previous `(rpcUrls, chainId, extraParams)` shape and the metadata-through-`extraParams` indirection.
  - The CLI warp-deploy preflight now sizes AltVM native-balance requirements from the composed per-chain deploy cost, so feature-heavy deploys are no longer silently under-funded, and chains without a gas price are no longer skipped for the warp-deploy path.
  - The AltVM warp-deploy base gas costs were calibrated from measured deploys (Sealevel from mainnet; Starknet, Aleo, and Radix from devnet base-router floors with safety margin), replacing the previous catastrophically-low placeholder constants that let preflight pass under-funded accounts.
  - The Starknet test fixture native token was corrected from ETH to STRK to match the production registry and the token the devnet actually charges fees in.

### Patch Changes

- 6793396: Fixed SVM warp-route program upgrades failing transaction simulation on clusters where the `enable_extend_program_checked` feature gate is inactive (e.g. Solana mainnet-beta). `prepareProgramUpgrade` queried the feature gate and emitted the legacy `ExtendProgram` (variant 6) instruction when the checked variant was unavailable, and clamped the program-data extend up to the loader's 10240-byte minimum instead of requesting the exact deficit (which the loader rejects). Added a generic `isFeatureActive` gate checker and a `program-extend-upgrade` e2e that exercised the unchecked extend path end-to-end against a feature-deactivated validator.

  Fixed the extend and upgrade racing the same slot when a `warp apply` both bumped `contractVersion` and set a fee: the loader rejects an Upgrade in the slot its program-data was extended ("Program was deployed in this block already"), and a program is not invocable in the slot it is upgraded. A generic `waitForSlotAdvance` hint was added to `SvmTransaction` and honored in `SvmSigner.send` — it polls until the cluster slot advances past the confirmed transaction's slot before reporting the send done, so the next transaction executes in a strictly later slot. `prepareProgramUpgrade` set the hint on the extend and upgrade transactions, guaranteeing extend → upgrade → config each land in separate slots. The signer stayed protocol-generic (no upgrade-specific logic) and the transactions remained emitted for export/multisig flows.

  `SvmSigner.signAndSend` surfaced the on-chain program logs from a failed preflight simulation (logged at `error` before rethrowing) so a failed apply shows why the transaction reverted (e.g. insufficient lamports, custom program errors) instead of a bare "Transaction simulation failed". `AltVMJsonRpcSubmitter` logged each transaction's annotation at `info` while submitting, matching the EVM `MultiProvider.sendTransaction` output.

  `prepareProgramUpgrade` clamped the program-data extend down to the remaining account headroom when growing to the loader's 10240-byte minimum would exceed Solana's 10 MiB account-data limit — the loader permits a sub-minimum extend that consumes exactly the remaining space — and failed fast with a clear message only when the new binary cannot fit the account at all, instead of letting an over-cap request produce an opaque on-chain loader error. `transactionToPrintableJson` carried the `waitForSlotAdvance` sequencing hint into its exported JSON, so file/Squads flows — where an external executor signs and submits the extend, upgrade, and config transactions — retained the directive to wait for the cluster slot to advance past each hinted transaction's confirmation slot before submitting the next one.

- Updated dependencies [4ef1fde]
  - @hyperlane-xyz/provider-sdk@8.0.0
  - @hyperlane-xyz/utils@39.0.0

## 38.0.0

### Minor Changes

- 961a89d: Two new CLI commands for managing offchain-signed warp fee quotes were added: `hyperlane warp quote create` submits a standing signed quote (`--ttl` in seconds, must be > 0) against a deployed `OffchainQuotedLinearFee` leaf on EVM or SVM, and `hyperlane warp quote read` enumerates the standing quotes stored on every supported chain in a warp route (or a single `--chain`), with an optional `--recipients` array to additionally probe non-router recipient addresses on protocols with non-enumerable storage (EVM). Output renders bytes32 sentinels (`TARGET_ROUTER_NONE`, `DEFAULT_CROSS_COLLATERAL_ROUTER`, `WILDCARD_RECIPIENT`) as labels with ISO timestamps and an `expired` flag. The CLI bridges EVM and AltVM via a single `factories.ts` switch (EVM doesn't implement `ProtocolProvider`), shared by both commands. Underneath, `@hyperlane-xyz/sdk` adds `EvmQuoteArtifactManager` / `EvmQuoteWriter` / `EvmQuoteReader` / `EvmPrivateKeyQuoteSigner` against the EIP-712 typed-data layout plus a `buildFeeReadContextFromWarpDeployConfig` helper that bypasses AltVM token-type validation; `@hyperlane-xyz/sealevel-sdk` adds the equivalent `SvmQuote*` surface against the SVM fee-program's `SubmitQuote` instruction and exports `resolveFeeSalt`; `@hyperlane-xyz/provider-sdk` defines the cross-VM interfaces (`IRawWarpQuoteArtifactManager`, `RawQuoteSigner`, `enumerateWarpQuoteCandidates`, `ReadStandingQuotesOpts`). For cross-collateral routes, `warp quote create` resolves the target router leaf from the destination's `remoteRouters` then `crossCollateralRouters` then the DEFAULT fallback, and accepts a `--target-router` override (destination-native address) to target a specific router-keyed leaf. `--quote-signer-key` also reads from the `HYP_QUOTE_SIGNER_KEY` env var, and a standing-quote submission that is an on-chain no-op (an equal-or-newer quote already exists) now warns instead of reporting success.

### Patch Changes

- Updated dependencies [961a89d]
  - @hyperlane-xyz/provider-sdk@7.2.0
  - @hyperlane-xyz/utils@38.0.0

## 37.0.0

### Major Changes

- 97e8ca1: SVM IGP fee config integration was added to the SVM SDK. SvmIgpHookReader was updated to surface the on-chain Igp.fee_config (signers + domainId + minIssuedAt) via the new feeConfig field on SvmDeployedIgpHook, and to expose the signer list through provider-sdk's IgpHookConfig.quoteSigners. SvmIgpHookWriter.create() and update() were updated to reconcile the multi-VM quoteSigners shape with on-chain state, mirroring EVM IGP semantics (undefined ⇒ leave on-chain state untouched, [] ⇒ keep fee_config Some without signers, [...] ⇒ initialize and/or Add/Remove diff). Clearing fee_config to None was intentionally left out of the declarative diff. The writer was wired to version-gate against the program's GetProgramVersion response (post-upgrade version when an upgrade fires in the same update) and to reject domain_id drift.

  Breaking change: SvmIgpHookWriterConfig was extended to require domainId, and SvmHookArtifactManager (exported as SealevelHookArtifactManager) was updated to take domainId as a required second constructor argument. SvmProtocolProvider was updated to thread chainMetadata.domainId through automatically, mirroring SvmMailboxConfig and SvmValidatorAnnounceConfig. The IGP program upgrade flow was wired through the writer using the existing prepareProgramUpgrade helper, hoisted out of warp/ into a shared deploy/program-upgrade.ts.

  Low-level codecs and instruction builders for the seven new IGP fee instructions were added: SetIgpQuoteConfig, SetIgpQuoteSigner, SetIgpMinIssuedAt, SubmitIgpQuote, CloseIgpTransientQuote, CloseIgpStandingQuote, and GetIgpQuoteAccountMetas. The IgpFeeConfig codec, IgpStandingQuote / IgpTransientQuote account decoders, the corresponding standing- and transient-quote PDA derivers, and WILDCARD_SENDER / WILDCARD_DOMAIN constants were promoted to public exports. SvmSignedQuote and GetIgpQuoteAccountMetasInput codecs were added with full encode/decode round-trip coverage.

  The provider-sdk IgpHookConfig was extended with optional contractVersion and quoteSigners fields, mirroring the EVM IgpSchema. Several previously private helpers were promoted to shared homes to support the new code without duplication: readAddress / readOptionAddress / ascii8 were moved into codecs/account-data.ts, and decodeBTreeSetH160 / decodeSetQuoteSignerOperation were colocated with the existing encoders in codecs/fee.ts. The svm-sdk unit-test runner glob was widened to src/\*_/_.unit-test.ts to pick up colocated codec / hook tests.

  The CLI gained `hyperlane hook deploy`, `hyperlane hook read`, and `hyperlane hook apply` commands, working across EVM and Alt-VM chains (including Sealevel IGP hooks with the fee config above). The shared read/parse/validate logic was extracted into a validateAndParseHookConfig helper so deploy and apply cannot drift, and the deploy path's config parse-error message was unified to lowercase "Invalid hook config".

### Minor Changes

- df34a68: TS SDK and CLI support was added for the Sealevel-only Composite ISM program (`hyperlane-sealevel-composite-ism`), a single program that stores an entire ISM tree — `TrustedRelayer`, `MultisigMessageId`, `Aggregation`, `Test`, `Pausable`, `AmountRouting`, `RateLimited`, `Routing`, and `FallbackRouting` nodes — in one PDA, in place of the many separately-deployed ISM contracts EVM uses. `hyperlane core`/`hyperlane warp` `deploy`/`apply`/`read`/`check` now work with a `compositeIsm` config the same as any other ISM type, config-file (YAML/JSON) input only.

  `@hyperlane-xyz/sdk` gained `IsmType.COMPOSITE` and a recursive `CompositeIsmNodeConfigSchema`/`CompositeIsmConfigSchema` mirroring the Rust CLI's config-file representation one-to-one; sub-nodes are inline Borsh data, not separate deployments, so only `routing`/`fallbackRouting.domains` (chain-name keyed, config-file-only) get diffed into per-domain instructions. The `ModuleType` enum was also fixed to use explicit values and gained `OP_L2_TO_L1`, `POLYMER`, and `COMPOSITE` members — it was previously auto-numbered and had silently drifted out of sync with `IInterchainSecurityModule.sol`'s enum, a pre-existing bug found while adding `COMPOSITE`.

  `@hyperlane-xyz/provider-sdk` gained the Artifact-API mirror of the composite ISM tree (domain-ID keyed), a `mergeIsmArtifacts` branch that treats `compositeIsm` as self-diffing (skips the generic Artifact recursion since sub-nodes aren't independently addressed), and recursive chain-name/domain-ID conversion in `ismConfigToArtifact`/`ismArtifactToDerivedConfig`.

  `@hyperlane-xyz/sealevel-sdk` gained the bulk of the new code: a hand-rolled Borsh codec for `IsmNode`/`CompositeIsmStorage`/`DomainIsmStorage` verified byte-for-byte against the Rust program's own serialization, PDA derivation for the shared VAM storage seed and per-domain seed, instruction builders for all seven mutating instructions, `SvmCompositeIsmReader`/`Writer`, a `detectIsmType()` probe, and the compiled program bytes embedded via the existing `program:build`/`program:generate` pipeline. `SvmCompositeIsmWriter.create()`'s `Initialize` call now passes `skipPreflight: true`, matching `SvmTestIsmWriter`'s existing workaround for a solana-test-validator race where preflight simulation can reject a just-deployed program with "Unsupported program id". A new `composite-ism.e2e-test.ts` exercises create/read, root updates, pause/unpause, ownership transfer, and routing-domain diffing end-to-end against a real local validator.

  `@hyperlane-xyz/deploy-sdk` registered `compositeIsm` as a supported, mutable ISM type and wired its writer's `update()` into the generic `IsmWriter`.

- cc4bdb6: `hyperlane core apply` was extended to upgrade the Sealevel mailbox program. A new optional `contractVersion` field was added to `MailboxArtifactConfig` (cross-VM) and `CoreConfigSchema` and threaded through the writer stack: `SvmMailboxReader.read` populated it from the on-chain `GetProgramVersion` instruction, `SvmMailboxWriter.update` ran `prepareProgramUpgrade` as the first step when an upgrade was needed, and the deploy-sdk `CoreWriter` / `CoreArtifactReader` forwarded the field through the `update` path. The `create` path deliberately did not forward it, so a fresh deploy installed whatever binary the SDK bundled rather than triggering a program upgrade mid-deploy. `EvmCoreReader.deriveCoreConfig` populated `contractVersion` from `Mailbox.PACKAGE_VERSION()` so the field round-tripped through `core read` for EVM as well as Sealevel. The EVM sentinel-version logic that was duplicated across `EvmCoreReader`, `EvmWarpRouteReader`, and `EvmTokenAdapter` was extracted into a shared `fetchPackageVersion` helper and `LEGACY_PACKAGE_VERSION` constant in the sdk's `utils/contract`. The svm-sdk's three per-program version fetchers (warp / IGP / mailbox) were unified behind a single shared internal `queryProgramVersionWithOwnerFallback` helper; the helper adopted warp's throw-on-fallback-failure semantic so real RPC errors were no longer masked as pre-versioned programs. Localnet test suites airdropped the (still-exported) `FALLBACK_SIMULATION_PAYER` in their `before()` to keep production-style reads (owners with no SOL) working in tests.
- 262073e: The Sealevel SDK gained first-class encoders for the bytes the offchain quote signer hashes into a `SvmSignedQuote`: `encodeSvmFeeQuoteContext` (44-byte Leaf/Routing or 76-byte Cross-Collateral context, discriminated by `targetRouter`), `encodeSvmIgpQuoteContext` (68-byte IGP context), and `encodeSvmIgpQuoteData` (33-byte IGP pricing data). `encodeFeeDataStrategy` plus the `FeeStrategyKind` / `SvmFeeDataStrategy` / `SvmFeeParams` types were also surfaced so consumers can produce the warp `data` slot without reaching past the SDK. The fee-program wildcard sentinels `WILDCARD_AMOUNT` (`u64::MAX`) and `wildcardRecipient()` (a factory returning a fresh `[0xFF; 32]`) were exported so offchain signers can mirror the on-chain `_matchesTransient` wildcard pattern when a field isn't fixed at sign time.

  `signSvmQuote` was changed to take `issuedAt` and `expiry` as `bigint` unix seconds instead of pre-encoded 6-byte `Uint8Array`s — the encoding moved inside the helper so the on-chain u48 BE wire format stays an implementation detail. The returned `SvmSignedQuote.issuedAt` / `.expiry` keep the existing `Uint8Array` shape consumed by `encodeSvmSignedQuote`. `signSvmQuote` and `encodeSvmIgpQuoteContext` were also updated to accept plain base58 strings for pubkey inputs (`feeAccount`, `payer`, `feeTokenMint`, `sender`); parsing happens internally so consumers don't import `address` from `@solana/kit` directly.

- c4b3ff5: SVM Address Lookup Table (ALT) support and the public transfer-remote instruction builders needed to drive offchain-quoted fees + quoted IGP gas payments were added.

  `SealevelAddressLookupTableReader` / `SealevelAddressLookupTableWriter` were introduced as an `ArtifactReader`/`Writer` pair over the on-chain ALT program. The writer's `create()` chunks extends, optionally freezes, and polls for activation (`tx_slot > last_extended_slot`) before returning so callers can use the new ALT in the very next tx. `update()` is idempotent — it computes the address diff (set-based, append-only), returns `[]` when the on-chain state already matches expected, and throws only when the requested mutation is unsatisfiable. The config shape is `{ frozen: boolean, addresses: Address[] }`; the on-chain authority is surfaced read-only via `SealevelDeployedAlt.authority`. `SealevelTransaction.addressLookupTables` accepts a plain `Address[]` of ALT pubkeys — the signer fetches each table's entries (`concurrentMap`) and assembles kit's `AddressesByLookupTableAddress` internally, then threads it through both `buildTransactionMessage` and `transactionToPrintableJson` (the Squads / offline-signing path previously inlined ALT-resolvable accounts and could exceed the 1232-byte packet limit).

  `getTokenTransferRemoteInstruction` (collateral / native / synthetic) and `getCrossCollateralTransferRemoteToInstruction` were added as public builders. Both accept optional `fee` and `igp.quoted` sections; the IGP section supports Legacy and Quoted modes against both `Igp` and `OverheadIgp` types, with the warp's sender program id captured in `IgpQuotedExtension.senderProgramId`. The CC remote path now correctly uses the mailbox dispatch authority (the CC-specific dispatch authority is for the local `HandleLocal` CPI path only), and the CC state PDA is marked readonly.

  `@solana-program/address-lookup-table` was added as a runtime dependency.

- 31f8b51: Added cross-VM plumbing for the warp orchestrator to thread a warp route's settlement asset into its paired fee config at deploy and update time:
  - `BaseFeeConfig` and `SyntheticWarpArtifactConfig` gained an optional `token` field, populated by the SVM synthetic warp reader/writer with the adapter-deployed mint PDA.
  - The deploy-sdk warp orchestrator deployed the warp first and then the fee with the resolved settlement asset, attaching it via the existing update path so per-asset setup (notably SVM beneficiary ATA creation via the new `buildBeneficiaryAtaIx`) ran against the now-known mint.
  - SVM leaf-fee readers returned params in bps shape with raw values carried alongside, and `shouldDeployNewFee` was rewritten around a semantic params comparison so apply/enroll round-trips no longer spuriously redeployed the fee.
  - The SVM fee writers only emitted a standalone beneficiary-ATA-create transaction when the ATA did not already exist on-chain (via the new `beneficiaryAtaExists` helper), so a no-op update converged to zero transactions and a fee-bearing deploy no longer force-sent an owner-signed ATA transaction through the deployer signer.
  - `computeRemoteRoutersUpdates` kept the current on-chain destination gas for an existing router when the expected config omitted it (and defaulted to `'0'` for new routers), instead of zeroing it.
  - The altVM branch of `executeWarpDeploy` deployed each warp as the deployer signer (intermediate owner), mirroring the EVM deployer, so post-deploy cross-chain router enrollment stayed authorized by the deployer key and ownership was handed to the configured owner during enrollment.

- 5122e71: A per-token-type ALT management surface for SVM warp routes was added. Each token type (native, collateral, synthetic, cross-collateral) gets a reader + writer pair (e.g. `SvmNativeTokenAltReader` / `SvmNativeTokenAltWriter`); the reader owns `deriveWarpRouteAddresses`, `read`, and `check` and only needs a `SealevelAddressLookupTableReader`, while the writer adds `create` and requires the signer-backed `SealevelAddressLookupTableWriter`. Dispatch-by-type is exposed through `SvmWarpAltManager.createWriter(type, options?)` and `SvmWarpAltReader.createReader(type)`, built via the public `createWarpAltManager` / `createWarpAltReader` factories that accept `ChainMetadataForAltVM`. Each writer's `create` emits frozen ALTs — a chain-shared `core` bucket (mailbox + IGP) and one-or-more `warpSpecific` buckets (warp PDAs + plugin static + fee/IGP cascades) split into chunks of `ALT_MAX_ADDRESSES` so cross-collateral routes with large domain × router fan-out stay under the on-chain 256-address cap. `createWriter` accepts an optional `existingCoreAlt: string` that, when supplied, is stored on the writer ctor and reuses that address as the core slot instead of creating a new one — letting callers regenerate only the warp-specific ALTs while a still-valid core survives.

### Patch Changes

- Updated dependencies [df34a68]
- Updated dependencies [cc4bdb6]
- Updated dependencies [31f8b51]
- Updated dependencies [97e8ca1]
  - @hyperlane-xyz/provider-sdk@7.1.0
  - @hyperlane-xyz/utils@37.0.0

## 36.0.0

### Major Changes

- 9bdab1d: SVM warp route fee integration was added. Warp token writers wired SetFeeConfig into the create and update flows with fee PDA validation, and readers were updated to surface the on-chain fee config. The token account decoder was extended to read the trailing Option<FeeConfig> field. Program version detection was added via GetProgramVersion simulation, gating explicit program upgrades that emit ExtendProgramChecked and Upgrade against the deployed BPF Loader v3 program. A contractVersion field was added to the provider-sdk warp config types, and compare-versions was promoted to the workspace catalog.

### Minor Changes

- aa41ce4: SVM fee program management was added to the SVM SDK with full create, read, and update support for all 6 fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting). The provider-sdk fee types were refactored with a FeeParams discriminated union (bps vs raw), PascalCase FeeType/FeeStrategyType values, expanded DerivedFeeConfig with resolved bigint fields, and a required FeeReadContext parameter on createFeeArtifactManager. Shared BPS fee utilities (computeBps, bpsToRawFeeParams, constants) were consolidated into provider-sdk as the single source of truth — sdk and svm-sdk now import from provider-sdk. The EVM SDK TokenFeeType was converted from enum to const object for structural compatibility. Legacy pre-fee program bytes were preserved for upgrade testing. The repeated account-decoding boilerplate in the fee and token decoders was consolidated into a shared decodeDiscriminatedAccount helper.
- 2f9d783: CLI warp deploy and warp apply commands were wired to drive SVM fee program lifecycles. A new tokenFeeInputToFeeConfig mapping was added to bridge EVM SDK fee config inputs to provider-sdk fee types, and tokenFee was plumbed through validateWarpConfigForAltVM so YAML configs flow into the multi-VM deploy/update path. The fee config input schema gained an optional beneficiary field so operators can set a beneficiary distinct from the owner; tokenFeeInputToFeeConfig now respects it (defaulting to owner when omitted) instead of forcing beneficiary = owner. tokenFeeInputToFeeConfig also now prefers raw maxFee/halfAmount over the schema's derived bps when both are present, so YAML configs authored as raw round-trip without silent bps conversion. The four SVM fee writers were switched to deploy programs with exact-byte-length data accounts (matching the warp token writer convention), halving the rent paid for each fee program. SvmWarpArtifactManager is now publicly exported from sealevel-sdk. provider-sdk now exports `DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY` from `@hyperlane-xyz/provider-sdk/warp` for downstream CLI/test code that needs to reference the wildcard cross-collateral target-router slot without depending on the main SDK.
- 5a5968f: A new Sealevel on-chain program (`composite-ism`) is added that supports a tree-structured ISM config with multisig, aggregation, routing, fallback routing, amount routing, pausable, trusted relayer, and rate-limited node types. Relayer support for building Sealevel composite ISM metadata is also added.

### Patch Changes

- Updated dependencies [9cd7606]
- Updated dependencies [aa41ce4]
- Updated dependencies [2f9d783]
- Updated dependencies [9bdab1d]
  - @hyperlane-xyz/utils@36.0.0
  - @hyperlane-xyz/provider-sdk@7.0.0

## 35.2.0

### Patch Changes

- @hyperlane-xyz/utils@35.2.0
- @hyperlane-xyz/provider-sdk@6.1.1

## 35.1.0

### Minor Changes

- d1b6f0a: Added new hook deploy command

### Patch Changes

- Updated dependencies [d1b6f0a]
  - @hyperlane-xyz/provider-sdk@6.1.0
  - @hyperlane-xyz/utils@35.1.0

## 35.0.1

### Patch Changes

- Updated dependencies [da1cfb1]
  - @hyperlane-xyz/utils@35.0.1
  - @hyperlane-xyz/provider-sdk@6.0.4

## 35.0.0

### Patch Changes

- @hyperlane-xyz/utils@35.0.0
- @hyperlane-xyz/provider-sdk@6.0.3

## 34.0.0

### Patch Changes

- @hyperlane-xyz/utils@34.0.0
- @hyperlane-xyz/provider-sdk@6.0.2

## 33.1.1

### Patch Changes

- @hyperlane-xyz/utils@33.1.1
- @hyperlane-xyz/provider-sdk@6.0.1

## 33.1.0

### Patch Changes

- Updated dependencies [bfe4d2e]
  - @hyperlane-xyz/provider-sdk@6.0.0
  - @hyperlane-xyz/utils@33.1.0

## 33.0.2

### Patch Changes

- b864cca: Multi-VM fee type support was added to provider-sdk and deploy-sdk. Fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting) were defined with Config API and Artifact API variants. FeeReader and FeeWriter with required FeeReadContext were added to deploy-sdk. Fee was integrated into warp types and the warp writer update flow. All protocol providers received createFeeArtifactManager stubs.
- Updated dependencies [b864cca]
- Updated dependencies [1f918d0]
  - @hyperlane-xyz/provider-sdk@5.1.0
  - @hyperlane-xyz/utils@33.0.2

## 33.0.1

### Patch Changes

- @hyperlane-xyz/utils@33.0.1
- @hyperlane-xyz/provider-sdk@5.0.3

## 33.0.0

### Patch Changes

- @hyperlane-xyz/utils@33.0.0
- @hyperlane-xyz/provider-sdk@5.0.2

## 32.0.1

### Patch Changes

- @hyperlane-xyz/utils@32.0.1
- @hyperlane-xyz/provider-sdk@5.0.1

## 32.0.0

### Major Changes

- 3dc6367: Core query methods (getIsmType, getRoutingIsm, getHookType, etc.) were removed from the IProvider interface and extracted into standalone query functions in each SDK. isMessageDelivered was kept on the interface to enforce all providers implement it.

  Starknet get\*Transaction methods were extracted into standalone tx builder functions (mailbox-tx.ts, ism-tx.ts, hook-tx.ts, warp-tx.ts) with their own parameter types, removing the dependency on provider-sdk Req/Res types.

  Tron and Aleo providers and signers had all get\*Transaction and action methods removed. Old e2e tests replaced with artifact API equivalents.

  76 Req/Res types were removed from provider-sdk altvm.ts, reducing it from 587 to 243 lines.

- fa08f2a: IProvider and ISigner interfaces were slimmed to their minimal surface. IProvider was reduced from 53 to 22 query-only methods by removing all get\*Transaction methods. ISigner was reduced from 36 to 5 infrastructure methods by removing all action methods (createMailbox, setDefaultIsm, enrollRemoteRouter, etc.). Transaction building is now handled exclusively by artifact managers using concrete class methods or standalone helper functions.

  Throwing stubs were removed from SVM, Cosmos, Radix, and Starknet provider/signer implementations. Old action-method-based e2e tests were replaced with artifact API equivalents. Cosmos routing ISM writer was fixed to handle domain route updates correctly via remove + re-add.

### Patch Changes

- ab17263: Fixed Solana-origin `warp send` by adding a legacy @solana/web3.js to @solana/kit transaction conversion layer. SDK adapters return legacy Transaction objects, but the SvmSigner expects kit-format instructions. The conversion handles instruction format translation, compute budget preservation, and extra signer (Keypair→TransactionSigner) conversion. SvmReceipt was extended with transaction meta (logs) fetched after confirmation so extractMessageIds works for Solana transfers.
- Updated dependencies [3dc6367]
- Updated dependencies [fa08f2a]
  - @hyperlane-xyz/provider-sdk@5.0.0
  - @hyperlane-xyz/utils@32.0.0

## 31.2.1

### Patch Changes

- @hyperlane-xyz/utils@31.2.1
- @hyperlane-xyz/provider-sdk@4.3.4

## 31.2.0

### Patch Changes

- @hyperlane-xyz/utils@31.2.0
- @hyperlane-xyz/provider-sdk@4.3.3

## 31.1.0

### Patch Changes

- @hyperlane-xyz/utils@31.1.0
- @hyperlane-xyz/provider-sdk@4.3.2

## 31.0.1

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/provider-sdk@4.3.1

## 31.0.0

### Patch Changes

- 44626fb: Enabled SVM cross-collateral token deployments in the CLI. Added `crossCollateral` to supported Alt-VM token types, allowing `warp deploy`, `warp combine`, and `warp apply` to work with SVM CC routes. Extracted `computeCrossCollateralRouterUpdates` into provider-sdk for cross-protocol reuse. Fixed CC-only gas preservation for domains transitioning from remote routers.
- eaac4ab: The sealevel ISM deploy flow was hardened by waiting for deployed programs to become visible and retrying initialization on chains that acknowledge deploys before the program is invokable.
- Updated dependencies [44626fb]
  - @hyperlane-xyz/provider-sdk@4.3.0
  - @hyperlane-xyz/utils@31.0.0

## 30.1.1

### Patch Changes

- @hyperlane-xyz/utils@30.1.1
- @hyperlane-xyz/provider-sdk@4.2.5

## 30.1.0

### Minor Changes

- 95c331e: Added cross-collateral token support to the SVM SDK, including create, read, and update operations for cross-collateral warp routes.

### Patch Changes

- b643062: Fixed serialized transaction output using the local keypair as fee payer instead of the actual authority (e.g. Squads vault). Added explicit feePayer field to SvmTransaction and set it on all update paths. Refactored IGP instruction builders to accept Address instead of TransactionSigner so the on-chain owner is used in serialized transactions.
  - @hyperlane-xyz/utils@30.1.0
  - @hyperlane-xyz/provider-sdk@4.2.4

## 30.0.0

### Major Changes

- 2a9b135: SvmSigner send/confirm flow was refactored with block-height-based polling, client-side rebroadcast, structured blockhash error detection via @solana/errors, and double-execution prevention for processed transactions. Program deployment write stages are now sent in parallel batches with retry on failure. Breaking: DeployStage requires a new `kind` field (DeployStageKind discriminant).

### Patch Changes

- Updated dependencies [37255ba]
- Updated dependencies [7646819]
  - @hyperlane-xyz/provider-sdk@4.2.3
  - @hyperlane-xyz/utils@30.0.0

## 29.1.0

### Patch Changes

- @hyperlane-xyz/utils@29.1.0
- @hyperlane-xyz/provider-sdk@4.2.2

## 29.0.1

### Patch Changes

- @hyperlane-xyz/utils@29.0.1
- @hyperlane-xyz/provider-sdk@4.2.1

## 29.0.0

### Minor Changes

- f0a33c6: Added `serializeUnsignedTransaction` to produce base58-encoded unsigned v0 transactions and messages compatible with the Rust Sealevel CLI output. `transactionToPrintableJson` now includes `transactionBase58`, `messageBase58`, and `annotation` fields alongside the existing human-readable format.

### Patch Changes

- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [3c6b1ad]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/utils@29.0.0
  - @hyperlane-xyz/provider-sdk@4.2.0

## 28.1.0

### Patch Changes

- 5caac66: Added `crossCollateral` warp token type to the provider-sdk type system. All protocol SDK artifact managers were updated to handle the new type in their exhaustive switches.
- Updated dependencies [5caac66]
  - @hyperlane-xyz/provider-sdk@4.1.0
  - @hyperlane-xyz/utils@28.1.0

## 28.0.0

### Patch Changes

- Updated dependencies [83767b9]
- Updated dependencies [a6b7bf3]
  - @hyperlane-xyz/provider-sdk@4.0.0
  - @hyperlane-xyz/utils@28.0.0

## 27.1.0

### Patch Changes

- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
  - @hyperlane-xyz/provider-sdk@3.1.0
  - @hyperlane-xyz/utils@27.1.0

## 27.0.0

### Minor Changes

- 22cb5cb: The `@hyperlane-xyz/sealevel-sdk` package (renamed from `@hyperlane-xyz/svm-sdk`) was published as a Solana/SVM client for Hyperlane Sealevel programs. It provides `SealevelProtocolProvider`, `SealevelProvider`, and `SealevelSigner` implementing the AltVM provider-sdk interfaces, along with warp token readers/writers (native, synthetic, collateral), ISM readers/writers (multisig message-ID, test), hook readers/writers (IGP, merkle tree), BPF program deployment/upgrade plans, PDA derivation utilities, and account decoders. ISM and hook deployment are not yet functional.

  `SealevelProtocolProvider` was registered in the deploy-sdk for `ProtocolType.Sealevel`, and `ProtocolType.Sealevel` was added to the CLI's supported protocols list, enabling `hyperlane warp deploy` for Solana chains.

### Patch Changes

- @hyperlane-xyz/utils@27.0.0
- @hyperlane-xyz/provider-sdk@3.0.1
