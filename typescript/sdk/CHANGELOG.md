# @hyperlane-xyz/sdk

## 38.0.0

### Major Changes

- 2208b91: - `QuotedTransferProvider` gained a `getQuotedTransferFee` method so display and submit call sites use the same protocol-agnostic entry point for offchain-quoted transfers.
  - `SealevelQuotedTransferProvider.getQuotedTransferFee` decodes the warp signed-quote `data` as a Borsh `FeeDataStrategy` (17 bytes, Linear-only) and applies the on-chain Linear formula at the transfer amount; the IGP signed-quote `data` decodes as a 33-byte `IgpQuoteData` (`token_exchange_rate ‖ gas_price ‖ token_decimals`) and the result is computed via `compute_gas_fee` against `tokenData.destination_gas` plus the per-destination `OverheadIgp.gas_overhead` (matching the on-chain `OverheadIgp::quote_gas_payment`).
  - `SealevelHypTokenAdapter.innerIgpFeeState` now exposes the resolved `gasOverheads` map alongside the inner-IGP account.
  - `WarpCore.getQuotedTransferFee` now takes `quotedTransfer: QuotedTransferProvider` — callers construct the provider themselves, mirroring `getTransferRemoteTxs({ quotedTransfer })`.
  - The EVM provider is refactored around a shared private `runQuoteExecute` helper and the dead `QuotedCallsParams.feeQuotes` reuse field is removed; both display and submit now invoke the `quoteExecute` eth_call independently (deterministic for a given `(quotes, clientSalt, block)`, so display ↔ submit results match within a block).
  - The `hyperlane warp send` CLI now unifies the preflight estimate behind `WarpCore.getQuotedTransferFee` for both EVM and Sealevel origins, logging the quoted IGP + token fee before submit.
  - The SVM fee-quoting service's CC quote-walker docstring is corrected to reflect that the on-chain CC submit handler enforces route scope via `CcQuoteFeeValidation::{Specific, Default}`; the `DEFAULT_ROUTER` transient-fallback behavior it describes already ships on `main`, and this change adds test coverage for it.
  - The Sealevel IGP fee computation normalizes the Borsh-decoded `destination_gas` and `gasOverheads` values (bn.js `BN` at runtime despite their `bigint` types) before arithmetic, so a `warp send` preflight on a fee-enabled SVM origin no longer crashes on the `BN`-vs-`bigint` type mismatch.
  - Legacy (non-upgraded) SVM IGP routes with no offchain `fee_config` now display the on-chain `quoteGasPayment` fee via the shared `SealevelHypTokenAdapter.quoteLegacyIgpGasPayment` helper instead of reporting IGP = 0, matching what the submit path pays.
  - `SealevelQuotedTransferProvider.getQuotedTransferFee` now skips IGP for same-domain (local) transfers — mirroring the submit path's local gate — so a local cross-collateral transfer no longer asserts on an unset `destination_gas`.
  - The SVM IGP fee computation now rejects a quote whose priced fee exceeds `u64`, mirroring the on-chain `as_u64()` narrowing, so preflight fails fast instead of displaying a fee the transfer could never pay.
  - Tests added for warp Linear strategy decode + IGP gas-fee math (12 new cases) and a CC DEFAULT_ROUTER cascade case in the SVM transfer-remote E2E.

### Minor Changes

- 961a89d: Two new CLI commands for managing offchain-signed warp fee quotes were added: `hyperlane warp quote create` submits a standing signed quote (`--ttl` in seconds, must be > 0) against a deployed `OffchainQuotedLinearFee` leaf on EVM or SVM, and `hyperlane warp quote read` enumerates the standing quotes stored on every supported chain in a warp route (or a single `--chain`), with an optional `--recipients` array to additionally probe non-router recipient addresses on protocols with non-enumerable storage (EVM). Output renders bytes32 sentinels (`TARGET_ROUTER_NONE`, `DEFAULT_CROSS_COLLATERAL_ROUTER`, `WILDCARD_RECIPIENT`) as labels with ISO timestamps and an `expired` flag. The CLI bridges EVM and AltVM via a single `factories.ts` switch (EVM doesn't implement `ProtocolProvider`), shared by both commands. Underneath, `@hyperlane-xyz/sdk` adds `EvmQuoteArtifactManager` / `EvmQuoteWriter` / `EvmQuoteReader` / `EvmPrivateKeyQuoteSigner` against the EIP-712 typed-data layout plus a `buildFeeReadContextFromWarpDeployConfig` helper that bypasses AltVM token-type validation; `@hyperlane-xyz/sealevel-sdk` adds the equivalent `SvmQuote*` surface against the SVM fee-program's `SubmitQuote` instruction and exports `resolveFeeSalt`; `@hyperlane-xyz/provider-sdk` defines the cross-VM interfaces (`IRawWarpQuoteArtifactManager`, `RawQuoteSigner`, `enumerateWarpQuoteCandidates`, `ReadStandingQuotesOpts`). For cross-collateral routes, `warp quote create` resolves the target router leaf from the destination's `remoteRouters` then `crossCollateralRouters` then the DEFAULT fallback, and accepts a `--target-router` override (destination-native address) to target a specific router-keyed leaf. `--quote-signer-key` also reads from the `HYP_QUOTE_SIGNER_KEY` env var, and a standing-quote submission that is an on-chain no-op (an equal-or-newer quote already exists) now warns instead of reporting success.

### Patch Changes

- 2208b91: EvmHookReader now determines whether an IGP is legacy from its on-chain `PACKAGE_VERSION` (via the shared `fetchPackageVersion` helper) instead of probing `quoteSigners()` and classifying the revert. A legacy IGP whose empty-data revert is wrapped by the `HyperlaneSmartProvider` ("All providers failed" / "Invalid response from provider", never a `CALL_EXCEPTION`) is now correctly classified as legacy rather than causing a fatal hook-derivation error. `quoteSigners()` is only called once the version gate confirms a v2+ IGP.
- 2208b91: The base Sealevel token adapter now skips the interchain gas (IGP) quote for same-domain (local) transfers, mirroring the cross-collateral adapter. Previously `quoteTransferGas` computed a non-zero IGP fee from `destination_gas` for a local destination, which surfaced as a spurious interchain gas fee in fee estimates (e.g. solana↔solana transfers) even though a local transfer sends no interchain message.
- 197b1e0: The default multisig ISM config for `solanadevnet` was added to `defaultMultisigConfigs`, matching the single-validator (threshold 1) convention used by `solanatestnet` and other low-priority testnets, so that any core deployment or ISM update connecting to solanadevnet as an origin picks up the correct validator set.
- 293abdc: The EVM warp route check now derives cross-collateral-routing (CCR) fee entries for every enrolled router key, not just the multi-collateral-enrolled subset. Previously `EvmWarpRouteReader` only seeded fee-mapping keys from on-chain `crossCollateralRouters` plus the default router key, so any `feeContracts` entry keyed under a normal `remoteRouters` address — including the local domain's own router for same-chain swaps — was never read, producing perpetual false-positive `tokenFee` violations in `check-warp-deploy`. The reader now unions `crossCollateralRouters`, `remoteRouters`, and the local router's own address when probing fee contracts.
- Updated dependencies [961a89d]
  - @hyperlane-xyz/provider-sdk@7.2.0
  - @hyperlane-xyz/deploy-sdk@7.2.0
  - @hyperlane-xyz/aleo-sdk@38.0.0
  - @hyperlane-xyz/cosmos-sdk@38.0.0
  - @hyperlane-xyz/radix-sdk@38.0.0
  - @hyperlane-xyz/tron-sdk@23.1.4
  - @hyperlane-xyz/starknet-core@38.0.0
  - @hyperlane-xyz/utils@38.0.0
  - @hyperlane-xyz/core@11.3.1

## 37.0.0

### Major Changes

- 262073e: The EVM-specific offchain-quoting logic in `WarpCore` was extracted behind a protocol-agnostic `QuotedTransferProvider` interface. `EvmQuotedTransferProvider` took over what was previously inlined in `WarpCore.getQuotedCallsTransferTxs` + `resolveQuotedCallsParams` + `getQuotedTransferFee`, and `WarpCore.getTransferRemoteTxs` gained an optional `quotedTransfer?: QuotedTransferProvider` that supersedes the legacy `quotedCalls?: QuotedCallsParams` field (kept as backwards-compatible sugar that wraps into an `EvmQuotedTransferProvider`). Existing callers passing `quotedCalls` keep producing byte-identical txs, and the public `getQuotedTransferFee` still returns the same shape. The new interface is the dispatch hook that future protocol implementations (Sealevel offchain quoting) plug into.

  **Breaking:** the `protected` methods `WarpCore.resolveQuotedCallsParams` and `WarpCore.getQuotedCallsTransferTxs` were removed — their logic now lives on `EvmQuotedTransferProvider`. There are no in-repo callers, but downstream `WarpCore` subclasses that referenced either method should instead pass a `quotedTransfer`/`quotedCalls` argument to `getTransferRemoteTxs` (or call the public `getQuotedTransferFee`), which route through the provider.

- 955281d: SVM token adapters were updated to support the on-chain fee flow: `quoteTransferRemoteGas` returns both warp-fee and IGP quotes when the route opts in, `populateTransferRemote(To)Tx` splices the fee + new-flow IGP sections into the account list, and transactions are compiled as `VersionedTransaction` with the registered Address Lookup Tables when `WarpCoreConfig.options.sealevel.altAddresses` is set. The exported `SolanaWeb3Transaction.transaction` field and the `SvmTransactionSigner.signTransaction` signature were widened from `Transaction` to `Transaction | VersionedTransaction`, a breaking change for consumers that call legacy-`Transaction`-only members without first narrowing the union.

### Minor Changes

- 262073e: `hyperlane warp send`'s offchain-quoting block was reworked to dispatch by origin protocol through the `QuotedTransferProvider` interface — EVM origins produced the legacy v1 `EvmQuotedTransferProvider` (wrapper-contract path), Sealevel origins produced a `SealevelQuotedTransferProvider` against the v2 fee-quoting API. The CLI internally reads the SVM warp route's `fee_config` to discover the fee program / fee-account PDA and wires up a `Connection` from `multiProtocolProvider.getSolanaWeb3Provider`. The `--fee-quoting-url` / `--fee-quoting-api-key` flags were extended to cover both protocols; no new SVM-prefixed flags. Mode (standing vs transient) is server-controlled — the SDK provider always sends a random client salt and infers mode from the response's `expiry === issuedAt` discriminator (the standalone `SealevelQuoteMode` export was removed since callers no longer pick the mode). Existing `quotedCalls` callers stay working via WarpCore's backcompat shim; new code should pass `quotedTransfer` directly. Validated end-to-end: 8 EVM warp-send e2e tests pass, the cross-chain SVM→EVM warp-send e2e passes against a live Solana validator, and the cross-chain CC EVM+SVM deploy/enroll suite passes.
- df34a68: TS SDK and CLI support was added for the Sealevel-only Composite ISM program (`hyperlane-sealevel-composite-ism`), a single program that stores an entire ISM tree — `TrustedRelayer`, `MultisigMessageId`, `Aggregation`, `Test`, `Pausable`, `AmountRouting`, `RateLimited`, `Routing`, and `FallbackRouting` nodes — in one PDA, in place of the many separately-deployed ISM contracts EVM uses. `hyperlane core`/`hyperlane warp` `deploy`/`apply`/`read`/`check` now work with a `compositeIsm` config the same as any other ISM type, config-file (YAML/JSON) input only.

  `@hyperlane-xyz/sdk` gained `IsmType.COMPOSITE` and a recursive `CompositeIsmNodeConfigSchema`/`CompositeIsmConfigSchema` mirroring the Rust CLI's config-file representation one-to-one; sub-nodes are inline Borsh data, not separate deployments, so only `routing`/`fallbackRouting.domains` (chain-name keyed, config-file-only) get diffed into per-domain instructions. The `ModuleType` enum was also fixed to use explicit values and gained `OP_L2_TO_L1`, `POLYMER`, and `COMPOSITE` members — it was previously auto-numbered and had silently drifted out of sync with `IInterchainSecurityModule.sol`'s enum, a pre-existing bug found while adding `COMPOSITE`.

  `@hyperlane-xyz/provider-sdk` gained the Artifact-API mirror of the composite ISM tree (domain-ID keyed), a `mergeIsmArtifacts` branch that treats `compositeIsm` as self-diffing (skips the generic Artifact recursion since sub-nodes aren't independently addressed), and recursive chain-name/domain-ID conversion in `ismConfigToArtifact`/`ismArtifactToDerivedConfig`.

  `@hyperlane-xyz/sealevel-sdk` gained the bulk of the new code: a hand-rolled Borsh codec for `IsmNode`/`CompositeIsmStorage`/`DomainIsmStorage` verified byte-for-byte against the Rust program's own serialization, PDA derivation for the shared VAM storage seed and per-domain seed, instruction builders for all seven mutating instructions, `SvmCompositeIsmReader`/`Writer`, a `detectIsmType()` probe, and the compiled program bytes embedded via the existing `program:build`/`program:generate` pipeline. `SvmCompositeIsmWriter.create()`'s `Initialize` call now passes `skipPreflight: true`, matching `SvmTestIsmWriter`'s existing workaround for a solana-test-validator race where preflight simulation can reject a just-deployed program with "Unsupported program id". A new `composite-ism.e2e-test.ts` exercises create/read, root updates, pause/unpause, ownership transfer, and routing-domain diffing end-to-end against a real local validator.

  `@hyperlane-xyz/deploy-sdk` registered `compositeIsm` as a supported, mutable ISM type and wired its writer's `update()` into the generic `IsmWriter`.

- 262073e: A `FeeQuotingV2Client` was added alongside the existing `FeeQuotingClient`, targeting the v2 fee-quoting API's `GET /v2/quote/warp` and `GET /v2/quote/igp` endpoints. Successful responses were decoded into an `AnyQuoteV2Entry`; 404 responses carrying the `no_quote_available` body were surfaced as a typed `FeeQuotingNoQuoteAvailableError` (with `reason` + `detail` fields) so consumers can branch on the cause without re-parsing the response. The SDK also gained `decodeSealevelQuoteEntry`, which converts the hex byte fields on a `SealevelQuoteV2Entry` into a `DecodedSealevelQuoteEntry` whose `signedQuote.*` fields are `Uint8Array` — structurally identical to what svm-sdk's submit-quote helpers consume, so the boundary can be duck-typed without the main SDK depending on `@hyperlane-xyz/sealevel-sdk`. Two new shared constants (`QUOTE_V2_BASE_PATH`, `QuoteV2Endpoint`) document the v2 URL contract. Successful responses were validated at the fetch boundary: the client now rejects a 2xx body whose per-protocol `details` payload fails hex-encoding or byte-length checks (EVM signed-quote fields and SVM `SvmSignedQuote` wire widths), so a shaped-but-garbage response fails loudly instead of surfacing later during transaction construction.
- cc4bdb6: `hyperlane core apply` was extended to upgrade the Sealevel mailbox program. A new optional `contractVersion` field was added to `MailboxArtifactConfig` (cross-VM) and `CoreConfigSchema` and threaded through the writer stack: `SvmMailboxReader.read` populated it from the on-chain `GetProgramVersion` instruction, `SvmMailboxWriter.update` ran `prepareProgramUpgrade` as the first step when an upgrade was needed, and the deploy-sdk `CoreWriter` / `CoreArtifactReader` forwarded the field through the `update` path. The `create` path deliberately did not forward it, so a fresh deploy installed whatever binary the SDK bundled rather than triggering a program upgrade mid-deploy. `EvmCoreReader.deriveCoreConfig` populated `contractVersion` from `Mailbox.PACKAGE_VERSION()` so the field round-tripped through `core read` for EVM as well as Sealevel. The EVM sentinel-version logic that was duplicated across `EvmCoreReader`, `EvmWarpRouteReader`, and `EvmTokenAdapter` was extracted into a shared `fetchPackageVersion` helper and `LEGACY_PACKAGE_VERSION` constant in the sdk's `utils/contract`. The svm-sdk's three per-program version fetchers (warp / IGP / mailbox) were unified behind a single shared internal `queryProgramVersionWithOwnerFallback` helper; the helper adopted warp's throw-on-fallback-failure semantic so real RPC errors were no longer masked as pre-versioned programs. Localnet test suites airdropped the (still-exported) `FALLBACK_SIMULATION_PAYER` in their `before()` to keep production-style reads (owners with no SOL) working in tests.
- 262073e: Added v2 fee-quoting API types alongside the legacy v1 (`/quote/*`) types. The v2 shape split a request into quoter-specific endpoints (`/v2/quote/warp` and `/v2/quote/igp`), returned at most one quote per response, and is protocol-agnostic via a generic envelope:
  - `QuoteV2Response` — `{ quote: AnyQuoteV2Entry }`
  - `QuoteV2Entry<P extends ProtocolType, D>` — protocol-discriminated envelope generic over `(protocol, details)` so new VMs are added by introducing a `*QuoteV2Entry` alias.
  - `EthereumQuoteV2Entry` — wraps `EthereumQuoteDetails` (existing EIP-712 `SignedQuoteData` + signature).
  - `SealevelQuoteV2Entry` — wraps `SealevelQuoteDetails` (`domainId` + hex-encoded `SvmSignedQuote` fields).
  - `AnyQuoteV2Entry` — discriminated union of the protocol variants.
  - `NoQuoteAvailableReason` const + type — `not_authorized | not_upgraded | not_configured`, the 404 reasons the v2 endpoints return when a quoter can't be resolved.
  - `NO_QUOTE_AVAILABLE_ERROR` constant for matching the 404 error code.

  v1 types (`SubmitQuoteCommand`, `FeeQuotingQuoteResponse`, `SignedQuoteData`) are unchanged — v2 is purely additive.

- 5122e71: `WarpCoreConfigSchema.options.sealevel.altAddresses` was added: an optional `Record<ChainName, { core: string; warpSpecific: string[] }>` map for tracking the Sealevel Address Lookup Tables associated with a warp route. `core` is the chain-shared ALT; `warpSpecific` lists the warp-route-specific ALTs. The field is scoped under `options.sealevel` to leave room for future Sealevel-only options without polluting the protocol-agnostic top level.
- 262073e: `SealevelQuotedTransferProvider` was added as the Sealevel implementation of `QuotedTransferProvider`. It composed a single atomic tx that prepended `SubmitFeeQuote` (and, for remote destinations whose origin token has IGP configured, `SubmitIgpQuote`) instructions onto the Sealevel adapter's `transfer_remote` / `transfer_remote_to` ix bundle — `[...computeBudgetIxs, submitFeeQuote, submitIgpQuote?, transferRemote]`. Atomicity is required for transient mode (one-shot PDA) and uniform for standing mode. Its constructor took only the v2 fee-quoting client, an SVM `Connection`, and an optional salt source (overridable for deterministic tests). The provider did not request a mode from the server: it always sent a fresh random client salt and inferred the server-selected mode from the response — transient quotes derived `scopedSalt = keccak256(payer || echoedClientSalt)` for both the on-chain PDA cascade and the IGP transient-quote PDA, while standing quotes used no scoped salt. A companion `composeSealevelTx` helper took a flat ix list + ALTs + fee payer and emitted either a legacy `Transaction` or a v0 `VersionedTransaction`, depending on whether ALTs were configured.
- 262073e: Web3.js-based instruction builders for the on-chain `SubmitQuote` (warp fee program) and `SubmitIgpQuote` (IGP program) handlers were added to `sealevelFee.ts`, mirroring `@hyperlane-xyz/sealevel-sdk`'s `@solana/kit` versions. `buildSubmitFeeQuoteIx` simulates `GetSubmitQuoteAccountMetas` to discover the variable cascade-PDA account list and substitutes the placeholder at slot 1 with the real payer; `buildSubmitIgpQuoteIx` composed the IGP's fixed 4-account layout (`[system, payer, igp, quotePda]`) and accepted a caller-derived quote PDA. The supporting Borsh schemas (`SealevelSvmSignedQuote`, `SealevelSubmitQuoteSchema`, `SealevelGetSubmitQuoteAccountMetasSchema`), an extended `simulateSubmitFeeQuoteAccountMetas` helper, and the `deriveIgpTransientQuotePda` PDA deriver shipped alongside. The IGP path is live: the on-chain SVM IGP handler accepts `SubmitIgpQuote`, and `SealevelQuotedTransferProvider` prepends it for remote transfers whose origin token has IGP configured.
- 262073e: The Sealevel warp adapters gained a Sealevel-only `getTransferRemoteIxBundle({ ..., scopedSalt? })` (and `getTransferRemoteToIxBundle` on the cross-collateral adapter) returning the building blocks of a `transfer_remote` tx — compute-budget ixs separated from the warp ixs, ALTs, fee payer, and signers — without compiling them into a `Transaction` / `VersionedTransaction`. Composing callers (e.g. the upcoming offchain-quoted-transfer provider) can prepend `SubmitFeeQuote` / `SubmitIgpQuote` ixs between the compute-budget head and the transfer ix to produce a single atomic tx. `scopedSalt` (optional, Sealevel-only) is the pre-scoped 32-byte salt — `keccak256(payer || clientSalt)`, not the raw client salt — for a same-tx offchain transient quote, threaded through to the fee + IGP cascade simulations so their PDA enumeration includes the transient quote PDA. `populateTransferRemoteTx` / `populateTransferRemoteToTx` were updated to wrap the bundle helper with a blockhash fetch + tx compilation — same external behavior, all 590 unit tests pass unchanged. The cross-VM `ITokenAdapter` interface is unchanged.
- 9c8b435: Added altvm support in warp check

### Patch Changes

- 92909f8: The warp route contract verification check now skips chains that have no Etherscan-API-compatible block explorer configured. Previously these chains (e.g. tronscan, zksync, keyless etherscan) produced an `Error` verification status that surfaced as a false-positive `ContractVerificationStatus` violation in `check-warp-deploy`; they are now reported as `Skipped`.
- af8e1f6: `EvmTokenAdapter.isApproveRequired`/`isRevokeApprovalRequired` were hardened to normalize the `allowance()` result through `BigNumber.from()` before comparing it, avoiding a `TypeError` when a substituted provider returned a non-`BigNumber` value. `WarpCore.getLocalTransferFee` was updated to return a conservative hard-coded gas estimate for Seismic-technicalStack origin chains instead of throwing, since unsigned `eth_call`/`eth_estimateGas` zeroes `msg.sender` on Seismic and breaks any handler logic keyed on it (e.g. `HypERC20`'s burn-on-transfer).
- c7895b6: The agent config schema gained an optional `index.interval` (seconds), letting the idle indexing poll interval (default 5s) and the validator checkpoint poll interval (default 2s) be statically overridden.
- 6e803be: Removed Cosmostation validators from the default multisig ISM configs for celestia, eden, forma, mantapacific, neutron, and stride, and set each chain's threshold to the minimum majority value (`floor(n/2) + 1`) enforced by `multisigIsm.test.ts`.
- cb0c7c9: Removed the stalled Luganodes validator from the default multisig ISM configs for unichain and fraxtal, lowering each chain's threshold from 4 to 3 to preserve the minimum majority (`floor(n/2) + 1`) over the remaining 5 validators.
- a82c918: Rotated the DSRV validator back into the solanamainnet default multisig ISM in place of the Zee Prime validator, which is shutting down. The threshold remains 3 of 5.
- 351cf01: Added narrow SDK subpath exports for quoted calls and the Predicate API client.
- 31f8b51: Added cross-VM plumbing for the warp orchestrator to thread a warp route's settlement asset into its paired fee config at deploy and update time:
  - `BaseFeeConfig` and `SyntheticWarpArtifactConfig` gained an optional `token` field, populated by the SVM synthetic warp reader/writer with the adapter-deployed mint PDA.
  - The deploy-sdk warp orchestrator deployed the warp first and then the fee with the resolved settlement asset, attaching it via the existing update path so per-asset setup (notably SVM beneficiary ATA creation via the new `buildBeneficiaryAtaIx`) ran against the now-known mint.
  - SVM leaf-fee readers returned params in bps shape with raw values carried alongside, and `shouldDeployNewFee` was rewritten around a semantic params comparison so apply/enroll round-trips no longer spuriously redeployed the fee.
  - The SVM fee writers only emitted a standalone beneficiary-ATA-create transaction when the ATA did not already exist on-chain (via the new `beneficiaryAtaExists` helper), so a no-op update converged to zero transactions and a fee-bearing deploy no longer force-sent an owner-signed ATA transaction through the deployer signer.
  - `computeRemoteRoutersUpdates` kept the current on-chain destination gas for an existing router when the expected config omitted it (and defaulted to `'0'` for new routers), instead of zeroing it.
  - The altVM branch of `executeWarpDeploy` deployed each warp as the deployer signer (intermediate owner), mirroring the EVM deployer, so post-deploy cross-chain router enrollment stayed authorized by the deployer key and ownership was handed to the configured owner during enrollment.

- Updated dependencies [df34a68]
- Updated dependencies [cc4bdb6]
- Updated dependencies [3771b2b]
- Updated dependencies [31f8b51]
- Updated dependencies [97e8ca1]
- Updated dependencies [9c8b435]
  - @hyperlane-xyz/provider-sdk@7.1.0
  - @hyperlane-xyz/deploy-sdk@7.1.0
  - @hyperlane-xyz/aleo-sdk@37.0.0
  - @hyperlane-xyz/cosmos-sdk@37.0.0
  - @hyperlane-xyz/radix-sdk@37.0.0
  - @hyperlane-xyz/tron-sdk@23.1.3
  - @hyperlane-xyz/starknet-core@37.0.0
  - @hyperlane-xyz/utils@37.0.0
  - @hyperlane-xyz/core@11.3.1

## 36.0.0

### Major Changes

- d288e7b: Refactor testIgpConfig function for clarity and maintainability
- d288e7b: fix(sdk): refactor `addVerificationArtifacts` for enhanced Artifact Deduplication in HyperlaneDeployer

### Minor Changes

- 2821252: Added SDK support for IGP fee token oracle configuration and warp route feeHook. The IGP schema now accepts `tokenOracleConfig` for per-ERC20 gas oracle configs, and warp route configs accept `feeHook` for setting the IGP address as a fee hook on TokenRouter. Full pipeline support across deploy, read, update, and check flows.
- aa41ce4: SVM fee program management was added to the SVM SDK with full create, read, and update support for all 6 fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting). The provider-sdk fee types were refactored with a FeeParams discriminated union (bps vs raw), PascalCase FeeType/FeeStrategyType values, expanded DerivedFeeConfig with resolved bigint fields, and a required FeeReadContext parameter on createFeeArtifactManager. Shared BPS fee utilities (computeBps, bpsToRawFeeParams, constants) were consolidated into provider-sdk as the single source of truth — sdk and svm-sdk now import from provider-sdk. The EVM SDK TokenFeeType was converted from enum to const object for structural compatibility. Legacy pre-fee program bytes were preserved for upgrade testing. The repeated account-decoding boilerplate in the fee and token decoders was consolidated into a shared decodeDiscriminatedAccount helper.
- 2f9d783: CLI warp deploy and warp apply commands were wired to drive SVM fee program lifecycles. A new tokenFeeInputToFeeConfig mapping was added to bridge EVM SDK fee config inputs to provider-sdk fee types, and tokenFee was plumbed through validateWarpConfigForAltVM so YAML configs flow into the multi-VM deploy/update path. The fee config input schema gained an optional beneficiary field so operators can set a beneficiary distinct from the owner; tokenFeeInputToFeeConfig now respects it (defaulting to owner when omitted) instead of forcing beneficiary = owner. tokenFeeInputToFeeConfig also now prefers raw maxFee/halfAmount over the schema's derived bps when both are present, so YAML configs authored as raw round-trip without silent bps conversion. The four SVM fee writers were switched to deploy programs with exact-byte-length data accounts (matching the warp token writer convention), halving the rent paid for each fee program. SvmWarpArtifactManager is now publicly exported from sealevel-sdk. provider-sdk now exports `DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY` from `@hyperlane-xyz/provider-sdk/warp` for downstream CLI/test code that needs to reference the wildcard cross-collateral target-router slot without depending on the main SDK.
- 32b87ad: The XERC20 module was extended to read and reconcile ownership in addition to limits. `EvmXERC20Reader` gained `readOwner` and `readProxyAdmin`, `EvmXERC20Module.read()` was updated to surface the token owner and ProxyAdmin owner, and `update()` was changed to append ownership-transfer transactions (for the token's `Ownable` owner and its ProxyAdmin owner) after limit/bridge changes. Expected owners for both the token and its ProxyAdmin were derived from the warp deploy config's top-level `owner`. The `hyperlane xerc20 apply` command was updated to transfer ownership through the same submitter strategy, so XERC20 ownership handoffs no longer require an infra script, and `hyperlane xerc20 read` now reports current owners.

### Patch Changes

- d288e7b: SmartProvider error handling was hardened for malformed provider errors, and MegaETH routing ISM enrollments were given a larger gas buffer.
- d288e7b: ICA fallback gas estimation was updated to use the derived interchain account as the sender, preventing owner-gated fallback estimates from inflating Tron gas quotes.
- d288e7b: Core deployments finalized core ownership before deploying TestRecipient, retried post-transaction ISM and hook reads to tolerate RPC read-after-write lag, and preserved nested RPC error messages when CALL_EXCEPTION wraps provider failures.
- 019201a: Fixed ISM initialization guard on retry, added in-place ISM sub-module updates for AGGREGATION and AMOUNT_ROUTING containers (with side-effect-free preflight, duplicate-key checks, CCIP cache propagation, and nested RATE_LIMITED support), and made Safe nonce fetching queue-aware with a manual override escape hatch.
- cc722b8: Composite submitters can now resolve a nested submitter whose type is only registered via a custom factory (such as the CLI's `file` submitter), and ICA file output is self-describing:
  - Threaded custom submitter factories through nested submitter resolution. Previously `getSubmitter` passed the bare `getSubmitter` as the recursive `getSubmitterFn`, defaulting `additionalSubmitterFactories` to an empty map, so a wrapping submitter (`interchainAccount` or `timelockController`) could not resolve a nested submitter registered only via a custom factory. The recursive getter now merges the parent's `additionalSubmitterFactories` into any factories a nested caller passes, so custom factories survive recursion at depth >= 2.
  - Refactored the SDK's ICA and timelock submitter schemas into the `buildEvmIcaTxSubmitterPropsSchema` and `buildEvmTimelockControllerSubmitterPropsSchema` builders (parameterized by the nested submitter schema) and exported them alongside the `EvmTimelockControllerSubmitterProps` type, so the CLI derives its extended strategy schemas from them instead of re-declaring the wrapper fields.
  - Widened the CLI's `ExtendedChainSubmissionStrategySchema` to accept any extended submitter (including `file`) as both the ICA `internalSubmitter` and the timelock `proposerSubmitter`. Previously the `file` submitter was permitted only at the top level and as an ICA `internalSubmitter`, rejecting it as a timelock `proposerSubmitter`. This also widens the optional `feeSubmitter` to the same recursive shape.
  - Set the `from` field of the ICA `callRemote` transaction to the configured ICA `owner` rather than the signer that populated it, so file-submitter output is self-describing for downstream broadcasters. `callRemote` derives the interchain account from `msg.sender`, so broadcasting from the deployer key would have silently routed the dispatch to the wrong account. Live submitters are unaffected because `MultiProvider.prepareTx` resets `from` to the actual signer.

- 9cd7606: `normalizeAddressEvm` now lowercases its input before checksumming, canonicalizing a bad-EIP-55-casing EVM address instead of returning it unchanged. `EvmIcaTxSubmitter.fromConfig` normalizes its origin-side EVM addresses (`owner`, origin `interchainAccountRouter`) up front, so bad casing no longer throws deep inside ethers mid-submission after irreversible deploys have run. Destination router and ISM (remote chain, not assumed EVM) are untouched.
- a6a3a33: Fixed EvmHypSyntheticAdapter.quoteTransferRemoteGas miscounting the bridged amount as a native fee for native warp routes (token() == address(0)), which inflated the IGP quote and caused downstream consumers (e.g. the rebalancer) to over-reserve costs. The transfer amount is now subtracted from the internal-fee quote before quotes are classified as native or ERC20.
- 2821252: The compare-versions dependency was moved to the workspace catalog.
- d288e7b: Optional core deployer contracts were omitted from returned contract maps when disabled instead of being returned as undefined values.
- 9bdab1d: SVM warp route fee integration was added. Warp token writers wired SetFeeConfig into the create and update flows with fee PDA validation, and readers were updated to surface the on-chain fee config. The token account decoder was extended to read the trailing Option<FeeConfig> field. Program version detection was added via GetProgramVersion simulation, gating explicit program upgrades that emit ExtendProgramChecked and Upgrade against the deployed BPF Loader v3 program. A contractVersion field was added to the provider-sdk warp config types, and compare-versions was promoted to the workspace catalog.
- cf6857e: `tryGetEvmExplorerMetadata` now restricts explorer-API usage to Etherscan-compatible families (Etherscan/Blockscout/Routescan/ZkSync) instead of only excluding `Other`, so non-Etherscan explorers such as TronScan are skipped cleanly instead of returning HTML that breaks JSON parsing during xERC20 bridge derivation (warp read / enrollment on Tron).
- cf6857e: Fixed XERC20 type detection (deriveXERC20TokenType) for xERC20 tokens deployed behind a proxy: it now resolves the implementation address and inspects its bytecode for the Velodrome/Standard selectors, instead of only checking the (delegatecall-stub) proxy bytecode. This fixes "Unable to detect XERC20 type … does not implement Standard or Velodrome XERC20 interface" for proxied xERC20 warp routes.
- Updated dependencies [9cd7606]
- Updated dependencies [aa41ce4]
- Updated dependencies [2f9d783]
- Updated dependencies [9bdab1d]
- Updated dependencies [823eca3]
- Updated dependencies [70586aa]
  - @hyperlane-xyz/utils@36.0.0
  - @hyperlane-xyz/provider-sdk@7.0.0
  - @hyperlane-xyz/deploy-sdk@7.0.0
  - @hyperlane-xyz/aleo-sdk@36.0.0
  - @hyperlane-xyz/cosmos-sdk@36.0.0
  - @hyperlane-xyz/radix-sdk@36.0.0
  - @hyperlane-xyz/tron-sdk@23.1.2
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/starknet-core@36.0.0

## 35.2.0

### Minor Changes

- 88e51ed: Removed the deprecated chains (milkyway, fluence, everclear, polynomialfi, story, merlin, degenchain, dogechain, tangle, b3, harmony, superpositionmainnet, arbitrumnova, fantom, moonbeam, aurora, polygonzkevm, zoramainnet, scroll, torus, redstone) from the default multisig ISM validator configs, the CCIP ISM chain consts, and the ISM gas-override destination list.
- f0b325a: Upgraded Safe SDK packages (api-kit 4.2.0, protocol-kit 7.2.0, safe-deployments 1.37.56), replaced the deprecated safe-core-sdk-types with types-kit, and added an explicit `getSafe` option for offline/read-only Safe construction when a chain's Safe transaction service is unavailable.
- 6db4aee: Added Seismic signed-read support for gas estimation. A new `ChainTechnicalStack.Seismic` value and a `SeismicSigner` were introduced so that, on Seismic chains, gas estimation for owner-gated functions is performed via a signed `eth_estimateGas` (a signed raw transaction from which the node recovers `msg.sender`) rather than an unsigned request where the `from` field is zeroed. Signers for chains with the Seismic technical stack are automatically wrapped by the MultiProvider.
- 867ce3c: A fee submitter strategy was added to `warp apply` allowing a separate Safe or signer to submit fee-contract transactions. Same-chain Safe TX Builder payloads are now bundled into a single combined file per (chainId, safeAddress) pair. Transaction ordering was fixed so fee-recipient updates execute before ownership transfers. Router-owner `setFeeRecipient` calls were moved into the main submitter batch so a dedicated feeSubmitter only ever sees fee-contract-owner transactions. Safe TX Builder bundles from successful chains are now written before surfacing any partial-failure errors.

### Patch Changes

- fb63f5f: The relayer agent config schema was updated to recognize `feeToken` gas payment enforcement config and reject non-native exact-token enforcement until token-aware IGP indexing is available. ERC20 IGP payments can still satisfy token-agnostic `onChainFeeQuoting` checks through the indexed destination gas amount.
- 889c68a: The precision-rebalance warning in `getLocalStorageGasOracleConfig` now names the local -> remote chain pair it applies to, so it is possible to tell which gas oracle config underflowed without correlating raw gas price / exchange rate values. An optional `onPrecisionFallback` callback was also added: when supplied it is invoked instead of logging per pair, letting callers aggregate the fallbacks into a single summary line across many chain pairs.
- fb63f5f: The SDK core and IGP deployers were updated to support recover-only legacy IGP configurations and opt out of QuotedCalls deployments. An `igpVersion` switch (`legacy`/`latest`) was added to the IGP hook config and a `deployQuotedCalls` switch to the core config; legacy IGP deploy paths are kept recover-only by requiring cached `proxyAdmin`, `storageGasOracle`, and `interchainGasPaymaster` addresses. `CoreConfigSchema` now rejects configs that pair a legacy IGP (`igpVersion: legacy`) with `deployQuotedCalls` left enabled, since QuotedCalls and the offchain-quoting IGP both require EIP-1153 transient storage and must ship together on the same chains.

  Legacy IGP configs that include `quoteSigners` now fail fast instead of silently skipping signer updates, because legacy IGP contracts do not expose the offchain-quoting signer interface.

- 92ef474: EvmTokenFeeDeployer caching is disabled so each sub-fee contract (e.g. every OffchainQuotedLinearFee inside a RoutingFee) receives its own deployment instead of sharing an address.

  HyperlaneJsonRpcProvider normalizes an empty-string `to` field to null on GetTransaction/GetTransactionReceipt responses, fixing an "invalid address" error thrown by ethers.js for contract-creation transactions on RPCs that return `""` instead of `null`.

  deriveTokenMetadata now propagates the `scale` field from the warp route config.

  sortArraysInConfig is fixed to handle non-object array elements (e.g. plain strings) without throwing when accessing `.type`.

- babb3d0: Fixed rate limit return values to not include recipient anymore
- b77faf4: The default Starknet provider builder now reads at the `latest` block instead of starknet.js's `pending` default, so balance and view calls no longer fail on RPC providers that reject `block_id: "pending"`.
- fb63f5f: The gas oracle exchange-rate computation in `getLocalStorageGasOracleConfig` was generalized to handle low-decimal fee tokens. When the fee token has fewer decimals than the remote native token (e.g. a 6-decimal ERC20 fee token paying for an 18-decimal native chain), the scaled exchange rate could fall below 1 and floor to a coarse integer, badly mispricing the quote. The existing precision-loss adjustment now also rebalances in this direction, shifting magnitude from the gas price into the exchange rate (their product, and thus the quote, is preserved) so the on-chain exchange rate keeps its precision. Same-decimal native pairs are unaffected.
- fb63f5f: The IGP hook config gained an optional `tokenOracleConfig` (keyed by fee token then remote chain) that wires per-fee-token gas oracles via `setTokenGasOracles` for ERC20-denominated interchain gas payments. Each fee token is backed by its own `StorageGasOracle`, oracle addresses are resolved from the on-chain `tokenGasOracles` mapping (no off-chain bookkeeping), and the path is gated behind non-legacy IGPs at contract version >= 11.3.0. The wiring was added to both the module path (`EvmHookModule`) and the deployer path (`HyperlaneIgpDeployer`, also used by `HyperlaneHookDeployer`) so infra deployments pick it up.
  - @hyperlane-xyz/aleo-sdk@35.2.0
  - @hyperlane-xyz/starknet-core@35.2.0
  - @hyperlane-xyz/cosmos-sdk@35.2.0
  - @hyperlane-xyz/radix-sdk@35.2.0
  - @hyperlane-xyz/utils@35.2.0
  - @hyperlane-xyz/deploy-sdk@6.1.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.1.1
  - @hyperlane-xyz/tron-sdk@23.1.1

## 35.1.0

### Minor Changes

- 830ce1d: Added a new `Seismic` value to the `ChainTechnicalStack` enum.

### Patch Changes

- 9cdf9eb: Warp core configs preserved warp route deploy token types, and destination collateral checks were skipped for CCTP and OFT collateral routes that settle through their protocol bridge rather than on-chain escrow.

  Existing CCTP and OFT registry routes require token type backfills in hyperlane-registry#1550 to use the exemption.

- Updated dependencies [d1b6f0a]
  - @hyperlane-xyz/provider-sdk@6.1.0
  - @hyperlane-xyz/cosmos-sdk@35.1.0
  - @hyperlane-xyz/radix-sdk@35.1.0
  - @hyperlane-xyz/aleo-sdk@35.1.0
  - @hyperlane-xyz/tron-sdk@23.1.0
  - @hyperlane-xyz/deploy-sdk@6.1.0
  - @hyperlane-xyz/starknet-core@35.1.0
  - @hyperlane-xyz/utils@35.1.0
  - @hyperlane-xyz/core@11.3.1

## 35.0.1

### Patch Changes

- 06a5b6b: Fixed EVM ISM, hook, ICA, and warp-route derivation to rethrow transient RPC failures during interface probes instead of silently returning incorrect derived configs. Configured routing hook children now fail fast when child hook derivation fails instead of being silently omitted.
- da1cfb1: A `syntheticCcrSwapMessageId` helper was added to `@hyperlane-xyz/utils` for deterministically computing the synthetic message ID of a same-chain CCR swap given its transaction hash and log index. The scraper agent config schema in `@hyperlane-xyz/sdk` was extended with an optional `ccrRouters` field mapping domain IDs to their CCR router-to-collateral address pairs.
- 4bb1c3e: Fixed solana fee estimation
- 93c2290: Fixed max transfer simulation and fee display for native-token warp routes by reverting to the minimal-amount fallback in getLocalTransferFee for non-predicate flows.
- Updated dependencies [da1cfb1]
  - @hyperlane-xyz/utils@35.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/aleo-sdk@35.0.1
  - @hyperlane-xyz/cosmos-sdk@35.0.1
  - @hyperlane-xyz/deploy-sdk@6.0.4
  - @hyperlane-xyz/provider-sdk@6.0.4
  - @hyperlane-xyz/radix-sdk@35.0.1
  - @hyperlane-xyz/tron-sdk@23.0.9
  - @hyperlane-xyz/starknet-core@35.0.1

## 35.0.0

### Major Changes

- 631d7e7: `ICoreAdapter.extractMessageIds` was made async (returns `Promise`). Callers must add `await` at call sites.

  `AleoCoreAdapter` extracted message IDs by querying on-chain mappings. Because Aleo's mailbox nonce counter is a single shared mapping entry, at most one dispatch is accepted per block; a confirmed transaction with type `"execute"` was the accepted dispatch, and the dispatched nonce is `mailbox.nonce - 1`. Unlike EVM/SVM adapters that parsed receipt logs, Aleo extraction required on-chain mapping queries. Callers constructing `MultiProtocolCore` for an Aleo origin chain had to supply a real mailbox address (not a stub); passing no address caused extraction to return an empty result rather than throw.

  Aleo warp token writers (native, collateral, synthetic) verified that the mailbox is initialized before deploying warp tokens. Previously, running `warp deploy` against an uninitialized mailbox produced a cryptic "transaction rejected" error from the on-chain finalize assertion; now a clear error is thrown immediately.

### Minor Changes

- 44aa432: Added a new `hyperlane warp balances` CLI command that displays token balances for each leg of a warp route. Fixed `EvmHypRebaseCollateralAdapter.getBridgedSupply` to return the underlying asset amount (previously returned raw vault shares). Added `EvmHypOwnerCollateralAdapter` that reads `assetDeposited` directly from `HypERC4626OwnerCollateral`, and routed `WarpCore.getTokenCollateral` through `getBridgedSupply` for ERC4626 collateral standards so destination-collateral checks and balance display no longer report zero for yield-bearing vault routes.
- a8c9430: Enabled warp send for Aleo. When Aleo is the origin chain, the CLI now skips delivery confirmation (message ID extraction from Aleo receipts is not yet supported) instead of throwing an error.

### Patch Changes

- 38479d0: The EvmIcaTxSubmitter now dynamically estimates destination-chain handle() gas via estimateIcaHandleGas instead of relying on the 50k default, so the encoded gasLimit matches the IGP payment and is sufficient for multi-call ICA transactions.
- 4adf279: Fixed warp apply when trying to remove warp fees from a warp route
- 7089676: Fixed offchain lookup ISM updates, cross-collateral fee updates, and CCTP/PREDICATE hook address preservation during on-chain config derivation.
- 6c687ee: Safe API Kit requests to Safe's hosted gateway were updated to use the SDK's authenticated default service resolution instead of forcing an explicit transaction service URL.
- Updated dependencies [631d7e7]
- Updated dependencies [f3851a3]
  - @hyperlane-xyz/aleo-sdk@35.0.0
  - @hyperlane-xyz/deploy-sdk@6.0.3
  - @hyperlane-xyz/starknet-core@35.0.0
  - @hyperlane-xyz/cosmos-sdk@35.0.0
  - @hyperlane-xyz/radix-sdk@35.0.0
  - @hyperlane-xyz/utils@35.0.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.0.3
  - @hyperlane-xyz/tron-sdk@23.0.8

## 34.0.0

### Major Changes

- 2151352: Move ICA call helper exports from the SDK root and `middleware/account/InterchainAccount` to `middleware/account/icaCalls`, and expose fee, middleware account, and utility modules through package subpath exports.

### Minor Changes

- f758a70: Added rate-limited ISM support.
- b8a600c: Added rate-limited hook support.

### Patch Changes

- 9a1ce26: Cosmos fee estimation clients were cached by reusing Stargate client connections across repeated estimates, with cache eviction on failures.
- Updated dependencies [9a1ce26]
  - @hyperlane-xyz/cosmos-sdk@34.0.0
  - @hyperlane-xyz/deploy-sdk@6.0.2
  - @hyperlane-xyz/aleo-sdk@34.0.0
  - @hyperlane-xyz/starknet-core@34.0.0
  - @hyperlane-xyz/radix-sdk@34.0.0
  - @hyperlane-xyz/utils@34.0.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.0.2
  - @hyperlane-xyz/tron-sdk@23.0.7

## 33.1.1

### Patch Changes

- 9ad1bd0: The `parseCustomRpcHeaders` utility is now exported from the SDK barrel so consumers outside `SmartProvider` can apply the `custom_rpc_header` URL convention to their own RPC clients.
- 530f02e: The IGP fee assertion is relaxed for Sealevel cross-collateral transfers; OffchainQuotedLinearFee is supported as a sub-fee of routing fees; warp deployment errors now surface their cause chain and Solana preflight logs.
- 9670e43: Fixed warp check for collateralDepositAddress routes
- cc90a8f: Improved derive token type by only fetching code once
  - @hyperlane-xyz/aleo-sdk@33.1.1
  - @hyperlane-xyz/starknet-core@33.1.1
  - @hyperlane-xyz/cosmos-sdk@33.1.1
  - @hyperlane-xyz/radix-sdk@33.1.1
  - @hyperlane-xyz/utils@33.1.1
  - @hyperlane-xyz/deploy-sdk@6.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.0.1
  - @hyperlane-xyz/tron-sdk@23.0.6

## 33.1.0

### Minor Changes

- 47649b7: Added CCTP hook type
- d9dec53: Relay API configuration fields were added to RelayerAgentConfigSchema (relayApiEnabled, relayApiPort, relayApiRateLimitMaxRequests, relayApiRateLimitWindowSecs, relayApiCorsOrigins). All fields are optional for backward compatibility.

### Patch Changes

- 6f4b790: Added batched transaction submission for hook, IGP, and routing ISM deployments to avoid hitting gas limits on chains with lower block gas caps. Chain-specific batch size overrides were added (e.g. citrea). Routing ISM deployment was refactored to deploy with an initial batch of domains and enroll the remainder individually, with per-chain initialization sizes; the final `transferOwnership` call is skipped when the deployer is already the configured owner. The gas buffer multiplier was increased for ISM factory deployments. A configurable `minConfirmationTimeoutMs` option was added to `MultiProvider`. The `defaultEthersV5ProviderBuilder` `retryOverride` parameter was widened from `ProviderRetryOptions` to `SmartProviderOptions` so callers can pass `fallbackStaggerMs`.
- bfe4d2e: Import cycles flagged by oxlint were resolved by extracting shared code into dedicated leaf modules, performing a hard cutover (no backcompat re-exports), and using dependency injection for submitter factories and aggregation metadata decoding. The `import/no-cycle` lint rule is now enforced as an error.
- 6929388: Fixed cctp transfer validation
- 0b1c1d1: Fixed two `WarpCore` issues for `QuotedCalls` flows:
  - Updated `resolveQuotedCallsParams` to treat `EvmHypNative` routes as native (zero-address token) by also checking `isHypNative()`. Previously, native warp routers were misidentified — `getQuotedTransferFee` returned `msg.value` (transfer amount + fee) as the IGP quote, so UIs displayed the bridged amount itself as "Interchain Gas".
  - Added an optional `quotedCalls` param to `getLocalTransferFee` and `getLocalTransferFeeAmount`, forwarded to `getTransferRemoteTxs`. Internal gas estimation now builds the actual `QuotedCalls.execute(...)` multicall instead of plain `transferRemote`, giving accurate pre-sign gas estimates for the QuotedCalls path. Callers were previously hardcoding `localQuote = 0`.

- Updated dependencies [bfe4d2e]
  - @hyperlane-xyz/provider-sdk@6.0.0
  - @hyperlane-xyz/aleo-sdk@33.1.0
  - @hyperlane-xyz/cosmos-sdk@33.1.0
  - @hyperlane-xyz/deploy-sdk@6.0.0
  - @hyperlane-xyz/radix-sdk@33.1.0
  - @hyperlane-xyz/tron-sdk@23.0.5
  - @hyperlane-xyz/starknet-core@33.1.0
  - @hyperlane-xyz/utils@33.1.0
  - @hyperlane-xyz/core@11.3.1

## 33.0.2

### Patch Changes

- 1f918d0: Added `@hyperlane-xyz/sdk` subpath exports for `core`, `hook`, and `ism` modules. Hardened `@hyperlane-xyz/utils` pretty-mode logging with a graceful fallback when `pino-pretty` is not installed.
- 78199f4: Added narrow runtime provider-builder exports for Tron and EVM-like consumers.
- Updated dependencies [b864cca]
- Updated dependencies [1f918d0]
  - @hyperlane-xyz/provider-sdk@5.1.0
  - @hyperlane-xyz/deploy-sdk@5.1.0
  - @hyperlane-xyz/cosmos-sdk@33.0.2
  - @hyperlane-xyz/radix-sdk@33.0.2
  - @hyperlane-xyz/aleo-sdk@33.0.2
  - @hyperlane-xyz/tron-sdk@23.0.4
  - @hyperlane-xyz/utils@33.0.2
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/starknet-core@33.0.2

## 33.0.1

### Patch Changes

- a2081df: Sealevel cross-collateral tokens were classified as cross-collateral again when building WarpCore routes.
- 4c91737: Added shared chain ID normalization helpers under the existing `metadata/*` subpath so metadata-first consumers can reuse the same chain ID and effective domain ID validation logic as the SDK resolver.
  - @hyperlane-xyz/aleo-sdk@33.0.1
  - @hyperlane-xyz/starknet-core@33.0.1
  - @hyperlane-xyz/cosmos-sdk@33.0.1
  - @hyperlane-xyz/radix-sdk@33.0.1
  - @hyperlane-xyz/utils@33.0.1
  - @hyperlane-xyz/deploy-sdk@5.0.3
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@5.0.3
  - @hyperlane-xyz/tron-sdk@23.0.3

## 33.0.0

### Major Changes

- dc8e560: Added Predicate integration for compliance-gated warp route transfers
  - Added `PredicateWrapperConfigSchema` for configuring predicate wrapper deployment
  - Added `PredicateApiClient` for fetching attestations from Predicate API
  - Added `PredicateWrapperDeployer` for deploying and configuring PredicateRouterWrapper contracts
  - Integrated predicate wrapper deployment into warp route deployment flow
  - Supported aggregation hooks with predicate wrapper (wrapper executes first)
  - Always aggregated predicate wrapper with mailbox default hook to ensure gas quoting works correctly
  - Detected PredicateRouterWrapper recursively inside nested aggregation hooks

  Example configuration:

  ```yaml
  ethereum:
    type: collateral
    token: '0x...'
    predicateWrapper:
      predicateRegistry: '0xe15a8Ca5BD8464283818088c1760d8f23B6a216E'
      policyId: 'x-your-policy-id'
  ```

### Patch Changes

- @hyperlane-xyz/aleo-sdk@33.0.0
- @hyperlane-xyz/starknet-core@33.0.0
- @hyperlane-xyz/cosmos-sdk@33.0.0
- @hyperlane-xyz/radix-sdk@33.0.0
- @hyperlane-xyz/utils@33.0.0
- @hyperlane-xyz/deploy-sdk@5.0.2
- @hyperlane-xyz/core@11.3.1
- @hyperlane-xyz/provider-sdk@5.0.2
- @hyperlane-xyz/tron-sdk@23.0.2

## 32.0.1

### Patch Changes

- 611b911: Normalized scale values in warp route check so plain numbers from config and {numerator, denominator} objects from on-chain reader compare equal during diff.
- c6de4c9: Updated warp check to validate OFT routes using OFT-specific sentinel router state and normalized empty extraOptions/domainMappings values.
  - @hyperlane-xyz/aleo-sdk@32.0.1
  - @hyperlane-xyz/starknet-core@32.0.1
  - @hyperlane-xyz/cosmos-sdk@32.0.1
  - @hyperlane-xyz/radix-sdk@32.0.1
  - @hyperlane-xyz/utils@32.0.1
  - @hyperlane-xyz/deploy-sdk@5.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@5.0.1
  - @hyperlane-xyz/tron-sdk@23.0.1

## 32.0.0

### Patch Changes

- e4da110: Fixed routing fee for non-evm legs
- d588eb5: Replaced z.coerce.bigint().positive() with ZBigNumberish.refine() in TokenMetadataSchema scale field for zod-to-json-schema compatibility. Fixed validateZodResult generic to correctly return output type for schemas with transforms.
- ab17263: Fixed Solana-origin `warp send` by adding a legacy @solana/web3.js to @solana/kit transaction conversion layer. SDK adapters return legacy Transaction objects, but the SvmSigner expects kit-format instructions. The conversion handles instruction format translation, compute budget preservation, and extra signer (Keypair→TransactionSigner) conversion. SvmReceipt was extended with transaction meta (logs) fetched after confirmation so extractMessageIds works for Solana transfers.
- ebde778: Fixed `deliver()` and `sendMessage()` in HyperlaneCore to connect the mailbox with the current signer at call time, preventing "sending a transaction requires a signer" errors when signers are added after construction. The `status --relay` command now exits non-zero when relay fails.
- Updated dependencies [3dc6367]
- Updated dependencies [fa08f2a]
  - @hyperlane-xyz/provider-sdk@5.0.0
  - @hyperlane-xyz/aleo-sdk@32.0.0
  - @hyperlane-xyz/tron-sdk@23.0.0
  - @hyperlane-xyz/cosmos-sdk@32.0.0
  - @hyperlane-xyz/radix-sdk@32.0.0
  - @hyperlane-xyz/deploy-sdk@5.0.0
  - @hyperlane-xyz/starknet-core@32.0.0
  - @hyperlane-xyz/utils@32.0.0
  - @hyperlane-xyz/core@11.3.1

## 31.2.1

### Patch Changes

- f9c8f83: Replaced z.coerce.bigint().positive() with pipe-based coercion in TokenMetadataSchema scale field to fix zod-to-json-schema compatibility in the registry build.
  - @hyperlane-xyz/aleo-sdk@31.2.1
  - @hyperlane-xyz/starknet-core@31.2.1
  - @hyperlane-xyz/cosmos-sdk@31.2.1
  - @hyperlane-xyz/radix-sdk@31.2.1
  - @hyperlane-xyz/utils@31.2.1
  - @hyperlane-xyz/deploy-sdk@4.3.4
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@4.3.4
  - @hyperlane-xyz/tron-sdk@22.1.14

## 31.2.0

### Minor Changes

- 35fb5c8: Shared scale conversion helpers were exported, and WarpCore preserved legacy collateral checks for mixed-decimal routes when scale metadata is missing.

### Patch Changes

- @hyperlane-xyz/aleo-sdk@31.2.0
- @hyperlane-xyz/starknet-core@31.2.0
- @hyperlane-xyz/cosmos-sdk@31.2.0
- @hyperlane-xyz/radix-sdk@31.2.0
- @hyperlane-xyz/utils@31.2.0
- @hyperlane-xyz/deploy-sdk@4.3.3
- @hyperlane-xyz/core@11.3.1
- @hyperlane-xyz/provider-sdk@4.3.3
- @hyperlane-xyz/tron-sdk@22.1.13

## 31.1.0

### Minor Changes

- c8fe242: Added request retries when fetching contract verification status from etherscan like apis to avoid having an incorrect status due to rate limits

### Patch Changes

- 8a082af: Added light subpath exports for SDK provider and warp modules, plus lean widget subpath exports.
- 8a082af: Added runtime entrypoints for non-EVM SDKs and avoided bundling heavy deploy-time modules in UI wallet integrations.
- Updated dependencies [8a082af]
  - @hyperlane-xyz/aleo-sdk@31.1.0
  - @hyperlane-xyz/cosmos-sdk@31.1.0
  - @hyperlane-xyz/radix-sdk@31.1.0
  - @hyperlane-xyz/tron-sdk@22.1.12
  - @hyperlane-xyz/deploy-sdk@4.3.2
  - @hyperlane-xyz/starknet-core@31.1.0
  - @hyperlane-xyz/utils@31.1.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@4.3.2

## 31.0.1

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/aleo-sdk@31.0.1
  - @hyperlane-xyz/cosmos-sdk@31.0.1
  - @hyperlane-xyz/deploy-sdk@4.3.1
  - @hyperlane-xyz/provider-sdk@4.3.1
  - @hyperlane-xyz/radix-sdk@31.0.1
  - @hyperlane-xyz/tron-sdk@22.1.11
  - @hyperlane-xyz/starknet-core@31.0.1

## 31.0.0

### Major Changes

- 69e6b3f: Warp route checks were unified onto the shared CLI comparison flow, including explicit proxyAdmin address checks and owner override ownership checks. The legacy `HypERC20App` and `HypERC20Checker` SDK exports were removed.

### Minor Changes

- 44626fb: Enabled SVM cross-collateral token deployments in the CLI. Added `crossCollateral` to supported Alt-VM token types, allowing `warp deploy`, `warp combine`, and `warp apply` to work with SVM CC routes. Extracted `computeCrossCollateralRouterUpdates` into provider-sdk for cross-protocol reuse. Fixed CC-only gas preservation for domains transitioning from remote routers.

### Patch Changes

- df33d41: Fixed sealevel fee payer
- 4963b32: Fix HypERC20Checker validation for EVM cross-collateral routes.
- 9003721: Warp check validated scale against configured crossCollateralRouters.
- fc0a1cf: Fixed tx overrides in token deploys
- Updated dependencies [44626fb]
- Updated dependencies [7ad1f9e]
- Updated dependencies [1dac3b0]
  - @hyperlane-xyz/provider-sdk@4.3.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/tron-sdk@22.1.10
  - @hyperlane-xyz/deploy-sdk@4.3.0
  - @hyperlane-xyz/aleo-sdk@31.0.0
  - @hyperlane-xyz/cosmos-sdk@31.0.0
  - @hyperlane-xyz/radix-sdk@31.0.0
  - @hyperlane-xyz/starknet-core@31.0.0
  - @hyperlane-xyz/utils@31.0.0

## 30.1.1

### Patch Changes

- 26d682b: Fee quoting client and shared types were moved from @hyperlane-xyz/fee-quoting into @hyperlane-xyz/sdk. The fee-quoting package was marked as private since it is a deployable service, not a published library.
  - @hyperlane-xyz/aleo-sdk@30.1.1
  - @hyperlane-xyz/starknet-core@30.1.1
  - @hyperlane-xyz/cosmos-sdk@30.1.1
  - @hyperlane-xyz/radix-sdk@30.1.1
  - @hyperlane-xyz/utils@30.1.1
  - @hyperlane-xyz/deploy-sdk@4.2.5
  - @hyperlane-xyz/core@11.3.0
  - @hyperlane-xyz/provider-sdk@4.2.5
  - @hyperlane-xyz/tron-sdk@22.1.9

## 30.1.0

### Minor Changes

- 71f0ca4: Added standalone `setMaxFeePpm` update path for CCTP V2 warp routes in `EvmWarpModule.update()`, so fee changes are applied even without a contract version upgrade.
- 6f8c503: QuotedCalls.quoteExecute was added for fee discovery via eth_call, returning per-command Quote[][] arrays. The SDK gained a QuotedCalls client with codec, builder, and WarpCore integration for atomic quoted transfers.
- 5eae48e: Added `SealevelHypCrossCollateralAdapter` for Sealevel cross-collateral warp token transfers. The adapter supports both same-chain (local CPI) and cross-chain (mailbox dispatch) paths, with account discovery via `HandleLocalAccountMetas` simulation. WarpCore CC transfer flow was made protocol-agnostic by replacing EVM-specific casts with an `isHypCrossCollateralAdapter` type guard. Added `SealevelHypCrossCollateral` token standard and wired it into the Token factory.

### Patch Changes

- 4c4462f: CrossCollateral contracts and tests were moved into the core Solidity package under `contracts/token` and `test/token`, and SDK imports were updated to use `@hyperlane-xyz/core` factories instead of `@hyperlane-xyz/multicollateral`.
- 9061916: CrossCollateralRoutingFee exposed an explicit feeType in the core contract interface.
- 2057d1a: CrossCollateralRoutingFee reader and update flows were fixed to preserve token context, support direct SDK updates, and encode CCRF fee-contract mutations correctly.
- e1f35a7: The offchain fee quoting service and client were added, with CLI integration for quoted transfers and SDK export of DEFAULT_ROUTER_KEY.
- b691b87: A deposit-address token bridge adapter was added in core, and the SDK deployer, reader, and config types were updated to support `collateralDepositAddress` routes.
- 57e46b1: The TokenBridgeOft contract, LayerZero IOFT interface, and Forge tests were moved into the core Solidity package. The SDK was updated to resolve TokenBridgeOft factories from `@hyperlane-xyz/core`, and the deprecated `@hyperlane-xyz/multicollateral` package was removed.
- Updated dependencies [9ac480a]
- Updated dependencies [9eefa2d]
- Updated dependencies [4c4462f]
- Updated dependencies [696da11]
- Updated dependencies [46dda6c]
- Updated dependencies [ac1acbb]
- Updated dependencies [d38fad1]
- Updated dependencies [cfed1d2]
- Updated dependencies [9061916]
- Updated dependencies [d41d088]
- Updated dependencies [b691b87]
- Updated dependencies [7018cc6]
- Updated dependencies [ef4399b]
- Updated dependencies [3fef31c]
- Updated dependencies [d98726f]
- Updated dependencies [40356c6]
- Updated dependencies [6f8c503]
- Updated dependencies [f2749a6]
- Updated dependencies [6bd4fd1]
- Updated dependencies [57e46b1]
- Updated dependencies [993de2b]
- Updated dependencies [b5f897c]
- Updated dependencies [9515191]
  - @hyperlane-xyz/core@11.3.0
  - @hyperlane-xyz/tron-sdk@22.1.8
  - @hyperlane-xyz/deploy-sdk@4.2.4
  - @hyperlane-xyz/aleo-sdk@30.1.0
  - @hyperlane-xyz/starknet-core@30.1.0
  - @hyperlane-xyz/cosmos-sdk@30.1.0
  - @hyperlane-xyz/radix-sdk@30.1.0
  - @hyperlane-xyz/utils@30.1.0
  - @hyperlane-xyz/provider-sdk@4.2.4

## 30.0.0

### Minor Changes

- d0dbf1a: PostCallsSchema is now a backwards-compatible union accepting either `destinationDomain` + `owner` (new ICA derivation path) or `commitmentDispatchTx` (legacy dispatch tx path). Added `isPostCallsIca()` type guard, `PostCallsIcaType`, `PostCallsLegacyType` exports, and `commitmentFromRevealMessage()` helper. Tightened schema validation to use ZHash for `owner`, `salt`, `ismOverride`, and `commitmentDispatchTx` fields.

### Patch Changes

- e1ed158: User-specified remoteRouters and destinationGas in warp deploy configs were ignored during router enrollment when the remote chains were not part of the deployment. enrollCrossChainRouters now merges user-specified entries with auto-discovered routers from deployed contracts.
- 95c2891: Routing fee config derivation skips non-EVM domains unknown to MultiProvider instead of throwing.
- Updated dependencies [ac297da]
- Updated dependencies [77db719]
- Updated dependencies [37255ba]
- Updated dependencies [7646819]
  - @hyperlane-xyz/core@11.2.0
  - @hyperlane-xyz/deploy-sdk@4.2.3
  - @hyperlane-xyz/provider-sdk@4.2.3
  - @hyperlane-xyz/utils@30.0.0
  - @hyperlane-xyz/multicollateral@1.0.2
  - @hyperlane-xyz/tron-sdk@22.1.7
  - @hyperlane-xyz/aleo-sdk@30.0.0
  - @hyperlane-xyz/cosmos-sdk@30.0.0
  - @hyperlane-xyz/radix-sdk@30.0.0
  - @hyperlane-xyz/starknet-core@30.0.0

## 29.1.0

### Minor Changes

- a8192d7: Added TronScan ExplorerFamily
- a891402: Added M0PortalAdapter for M0 Portal token transfers

### Patch Changes

- @hyperlane-xyz/aleo-sdk@29.1.0
- @hyperlane-xyz/starknet-core@29.1.0
- @hyperlane-xyz/cosmos-sdk@29.1.0
- @hyperlane-xyz/radix-sdk@29.1.0
- @hyperlane-xyz/utils@29.1.0
- @hyperlane-xyz/deploy-sdk@4.2.2
- @hyperlane-xyz/core@11.1.0
- @hyperlane-xyz/provider-sdk@4.2.2
- @hyperlane-xyz/tron-sdk@22.1.6

## 29.0.1

### Patch Changes

- 96508ed: Added support for scale-down convention in verifyScale, accepting both scale-up and scale-down routes for cross-decimal configurations. Fixed verifyScale to reject mismatched scales when decimals are uniform across chains. Added positivity constraint to bigint scale schema fields. Improved decimals assertion to use nullish check instead of truthiness.
  - @hyperlane-xyz/aleo-sdk@29.0.1
  - @hyperlane-xyz/starknet-core@29.0.1
  - @hyperlane-xyz/cosmos-sdk@29.0.1
  - @hyperlane-xyz/radix-sdk@29.0.1
  - @hyperlane-xyz/utils@29.0.1
  - @hyperlane-xyz/deploy-sdk@4.2.1
  - @hyperlane-xyz/core@11.1.0
  - @hyperlane-xyz/provider-sdk@4.2.1
  - @hyperlane-xyz/tron-sdk@22.1.5

## 29.0.0

### Major Changes

- cc6d57b: The bps type was changed from bigint to number throughout the LinearFee fee system to support fractional basis points (e.g., 1.5 bps).

  Breaking changes:
  - `convertToBps()` return type changed from `bigint` to `number`
  - `convertFromBps()` parameter type changed from `bigint` to `number`
  - `LinearFeeConfig.bps` and `LinearFeeInputConfig.bps` types changed from `bigint` to `number`
  - `ZBps` schema no longer accepts `bigint` input — callers using `bps: 5n` must change to `bps: 5`
  - `TokenFeeConfigSchema` and `LinearFeeConfigSchema` bps field type changed from `bigint` to `number`

### Patch Changes

- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [3c6b1ad]
- Updated dependencies [09d6760]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/tron-sdk@22.1.4
  - @hyperlane-xyz/utils@29.0.0
  - @hyperlane-xyz/deploy-sdk@4.2.0
  - @hyperlane-xyz/aleo-sdk@29.0.0
  - @hyperlane-xyz/cosmos-sdk@29.0.0
  - @hyperlane-xyz/provider-sdk@4.2.0
  - @hyperlane-xyz/radix-sdk@29.0.0
  - @hyperlane-xyz/core@11.1.0
  - @hyperlane-xyz/starknet-core@29.0.0

## 28.1.0

### Minor Changes

- 6c715a7: Added support for MinimalInterchainAccountRouter deployment and detection.

### Patch Changes

- 2e622e8: `isEVMLike()` replaced direct `ProtocolType.Ethereum` comparisons in `HyperlaneCore`, `RouterApps`, and `HyperlaneAppChecker` so Tron chains are correctly included in router configs, address lookups, and deploy checks.
- e93a4c8: Fixed Tron EthersV5 provider to use TronJsonRpcProvider (which appends `/jsonrpc` to the RPC URL) instead of HyperlaneSmartProvider, preventing 302 redirect failures on Tron nodes.
- Updated dependencies [5caac66]
- Updated dependencies [6c715a7]
- Updated dependencies [2e622e8]
  - @hyperlane-xyz/provider-sdk@4.1.0
  - @hyperlane-xyz/radix-sdk@28.1.0
  - @hyperlane-xyz/cosmos-sdk@28.1.0
  - @hyperlane-xyz/aleo-sdk@28.1.0
  - @hyperlane-xyz/core@11.1.0
  - @hyperlane-xyz/tron-sdk@22.1.3
  - @hyperlane-xyz/deploy-sdk@4.1.0
  - @hyperlane-xyz/multicollateral@1.0.1
  - @hyperlane-xyz/starknet-core@28.1.0
  - @hyperlane-xyz/utils@28.1.0

## 28.0.0

### Major Changes

- b9c6844: MultiCollateral contracts and SDK/CLI terminology were renamed to CrossCollateral.

  The Solidity ABI was updated with renamed contracts, interfaces, router enrollment methods, domain/route getters, fee-quote method, events, and revert prefixes.

  The SDK token type was migrated to `crossCollateral`.

  Reader compatibility for legacy deployed contracts was not retained; readers now require the renamed CrossCollateral ABI methods.

### Patch Changes

- 5a5d172: Added utilities for filtering warp routes by chains: `getChainsFromWarpCoreConfig`, `warpCoreConfigMatchesChains`, and `filterWarpCoreConfigMapByChains`. These enabled CLI commands with origin/destination to auto-resolve warp routes when chains uniquely identify a route.
- a4a74d8: TokenBridgeOft was refactored to remove TokenRouter inheritance, implementing ITokenBridge directly with OwnableUpgradeable. The contract no longer requires a mailbox, remote router enrollment, or destination gas configuration. Fee recipient support was removed and OFT fee quotes were consolidated into a single token quote entry. SDK deployer, warp route reader, and warp module were updated to handle OFT configs separately from Router-based configs.
- Updated dependencies [26d08de]
- Updated dependencies [83767b9]
- Updated dependencies [228ed9f]
- Updated dependencies [b9c6844]
- Updated dependencies [a6b7bf3]
- Updated dependencies [a6b7bf3]
- Updated dependencies [a4a74d8]
  - @hyperlane-xyz/aleo-sdk@28.0.0
  - @hyperlane-xyz/deploy-sdk@4.0.0
  - @hyperlane-xyz/provider-sdk@4.0.0
  - @hyperlane-xyz/cosmos-sdk@28.0.0
  - @hyperlane-xyz/multicollateral@1.0.0
  - @hyperlane-xyz/core@11.0.3
  - @hyperlane-xyz/radix-sdk@28.0.0
  - @hyperlane-xyz/tron-sdk@22.1.2
  - @hyperlane-xyz/starknet-core@28.0.0
  - @hyperlane-xyz/utils@28.0.0

## 27.1.0

### Minor Changes

- a1f9e41: Added Safe contract overrides for igra chain (chain ID 38833).
- 7af7728: Added optional `warpRouteId` field to TokenConfigSchema for disambiguating tokens that share the same addressOrDenom on the same chain (e.g. M0 Portal tokens). When present, WarpCore.FromConfig uses it during connection resolution to ensure tokens connect only within their own warp route.

### Patch Changes

- de5f6b5: Fixed fetchScale version gate to compare against the contract version where scaling was first introduced (6.0.0) instead of the fraction scaling version (11.0.0), preventing failed scale() reads on pre-scaling contracts.
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [abdbbf5]
- Updated dependencies [b892e61]
  - @hyperlane-xyz/provider-sdk@3.1.0
  - @hyperlane-xyz/deploy-sdk@3.1.0
  - @hyperlane-xyz/radix-sdk@27.1.0
  - @hyperlane-xyz/utils@27.1.0
  - @hyperlane-xyz/aleo-sdk@27.1.0
  - @hyperlane-xyz/cosmos-sdk@27.1.0
  - @hyperlane-xyz/tron-sdk@22.1.1
  - @hyperlane-xyz/core@11.0.2
  - @hyperlane-xyz/starknet-core@27.1.0

## 27.0.0

### Minor Changes

- b05e242: An `extraSigners` field was added to `SolanaWeb3Transaction` and `TransferRemoteParams` to properly thread Sealevel keypairs through the typed transaction pipeline. WarpCore now generates and passes a `Keypair` for SolanaWeb3 transfers, and `SealevelHypTokenAdapter` consumes it instead of generating its own. `KeypairSvmTransactionSigner.signTransaction` was changed to use `partialSign` to preserve extra signer signatures across blockhash resubmits.

### Patch Changes

- f2620a1: Defensive null guards were added to RPC log field parsing, EvmEventLogsReader, and xerc20 receipt handling. fork.sh was hardened with variable quoting, stale anvil cleanup, and IGP-only --asDeployer. CLI e2e setup was updated with metadata-driven Tron config and private key normalization. Pre-existing lint warnings were fixed.
- f7ebf6c: `quoteTransferRemoteTo` was fixed to work without a default `Router._routers` enrollment by adding a target-router-aware gas quote helper. `GasRouter._setDestinationGas` was made virtual and overridden in CrossCollateralRouter to accept MC-enrolled-only domains, keeping the existing `setDestinationGas` function selector working for all domain types. Authorization checks were deduplicated into `_requireAuthorizedRouter`. SDK EvmWarpRouteReader was updated to include MC-enrolled domains when reading destination gas.
- 8a6f742: MultiProvider was updated to cache connected signers for stable instance identity and route setProviders() through setProvider() for consistent signer reconnection. ISM factory now simulates deploy address via eth_call when getAddress() returns incorrect results. Defensive null assertions were added across MultiProvider methods. HyperlaneCore onDispatch errors are now caught and logged separately.
- aee625c: SmartProvider was updated to skip retry and stagger fanout for SendTransaction to prevent nonce errors from duplicate submissions. SendTransaction now breaks out of the provider fallback loop on any error. GetGasPrice and GetTransactionCount were excluded from etherscan routing.
- f38db60: Public MultiCollateral SDK APIs were renamed to CrossCollateral equivalents (for example `EvmMultiCollateralAdapter` → `EvmCrossCollateralAdapter` and related module/reader exports). Consumers should update import names accordingly.
- Updated dependencies [4a816e3]
- Updated dependencies [f7ebf6c]
- Updated dependencies [22cb5cb]
  - @hyperlane-xyz/tron-sdk@22.1.0
  - @hyperlane-xyz/multicollateral@0.2.0
  - @hyperlane-xyz/core@11.0.2
  - @hyperlane-xyz/deploy-sdk@3.0.1
  - @hyperlane-xyz/aleo-sdk@27.0.0
  - @hyperlane-xyz/starknet-core@27.0.0
  - @hyperlane-xyz/cosmos-sdk@27.0.0
  - @hyperlane-xyz/radix-sdk@27.0.0
  - @hyperlane-xyz/utils@27.0.0
  - @hyperlane-xyz/provider-sdk@3.0.1

## 26.0.0

### Major Changes

- 1d116d8: Added Tron ProtocolType & deprecated Tron TechnicalStack. Add support for TronLink wallet in the widgets.

### Minor Changes

- 43255a9: CrossCollateralRouter warp route support was added across the SDK, CLI, and warp monitor.

  SDK: WarpCore gained `transferRemoteTo` flows for crossCollateral tokens, including fee quoting, ERC-20 approval, and destination token resolution. EvmWarpModule now handles CrossCollateral router enrollment/unenrollment with canonical router ID normalization. EvmWarpRouteReader derives crossCollateral token config including on-chain scale. A new `EvmCrossCollateralAdapter` provides quote, approve, and transfer operations.

  CLI: `warp deploy` and `warp extend` support crossCollateral token types. A new `warp combine` command merges independent warp route configs into a single crossCollateral route. `warp send` and `warp check` work with crossCollateral routes.

  Warp monitor: Pending-transfer and inventory metrics were added for crossCollateral routes, with projected deficit scoped to collateralized routes only.

- 763a264: An optional `options` parameter was added to `sendAndConfirmTransaction()` on `IMultiProtocolSigner`, reusing `SendTransactionOptions` from `MultiProvider`. The EVM adapter passes options (including `waitConfirmations`) directly through to `MultiProvider.sendTransaction()`. Other protocol adapters accept but ignore the parameter. This is a non-breaking change.

### Patch Changes

- Updated dependencies [06aacac]
- Updated dependencies [1d116d8]
  - @hyperlane-xyz/utils@26.0.0
  - @hyperlane-xyz/provider-sdk@3.0.0
  - @hyperlane-xyz/tron-sdk@22.0.0
  - @hyperlane-xyz/core@11.0.1
  - @hyperlane-xyz/aleo-sdk@26.0.0
  - @hyperlane-xyz/cosmos-sdk@26.0.0
  - @hyperlane-xyz/deploy-sdk@3.0.0
  - @hyperlane-xyz/radix-sdk@26.0.0
  - @hyperlane-xyz/starknet-core@26.0.0

## 25.5.0

### Minor Changes

- c2304d3: Add EvmHypOwnerCollateral yield route standard to TOKEN_COLLATERALIZED_STANDARDS
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

### Patch Changes

- cd1c28a: The xERC20 lockbox adapter was updated to resolve the wrapped token address directly from the lockbox contract instead of the inherited collateral adapter, fixing `getBridgedSupply()` failures on older lockbox deployments.
- 69b48fa: The PostCallsSchema was tightened to validate `to` and `relayers` fields with ZHash regex, rejecting malicious input (empty strings, URLs, injection payloads) at parse time. A try/catch was added around `normalizeCalls` in `CallCommitmentsService` as defense-in-depth to return 400 instead of crashing the pod.
- 048df98: Corrected validator alias from O-OPS to P-OPS Team in multisig ISM constants.
- Updated dependencies [e197331]
- Updated dependencies [840fb33]
  - @hyperlane-xyz/deploy-sdk@2.0.0
  - @hyperlane-xyz/provider-sdk@2.0.0
  - @hyperlane-xyz/aleo-sdk@25.5.0
  - @hyperlane-xyz/cosmos-sdk@25.5.0
  - @hyperlane-xyz/radix-sdk@25.5.0
  - @hyperlane-xyz/tron-sdk@21.1.5
  - @hyperlane-xyz/starknet-core@25.5.0
  - @hyperlane-xyz/utils@25.5.0
  - @hyperlane-xyz/core@11.0.1

## 25.4.1

### Patch Changes

- 5a7efbb: Fixed `getHypAdapter` to handle `EvmNative` tokens with warp connections by returning `EvmHypNativeAdapter`, enabling cross-chain transfers for mint/burn native gas tokens. Also fixed gas estimation in `WarpCore.getLocalTransferFee` to use a decimal-aware amount that survives on-chain truncation between chains with different decimals.
  - @hyperlane-xyz/aleo-sdk@25.4.1
  - @hyperlane-xyz/starknet-core@25.4.1
  - @hyperlane-xyz/cosmos-sdk@25.4.1
  - @hyperlane-xyz/radix-sdk@25.4.1
  - @hyperlane-xyz/utils@25.4.1
  - @hyperlane-xyz/deploy-sdk@1.4.1
  - @hyperlane-xyz/provider-sdk@1.4.1
  - @hyperlane-xyz/tron-sdk@21.1.4
  - @hyperlane-xyz/core@11.0.1

## 25.4.0

### Minor Changes

- d4a5026: SDK handles both old (`maxFeeBps()`) and new (`maxFeePpm()`) contract interfaces via version-gated calls.
- 934d857: SDK converts bps config to ppm for deployment and ppm back to bps when reading.
- 942bbfb: SDK support for `approveFeeTokenForHook`:
  - Added `feeTokenApprovals` config field to `IcaRouterConfigSchema` for specifying fee token approvals at deploy time
  - `InterchainAccountDeployer` now calls `approveFeeTokenForHook` for each configured approval after deployment
  - `EvmIcaModule.update()` generates approval transactions for any missing fee token approvals

- a3f7fd3: SDK integration for IncrementalDomainRoutingIsm: factory support, reader implementation, and proper delta handling in routingModuleDelta.

### Patch Changes

- 1f3a0e6: Added retry with exponential backoff in EvmEventLogsReader before falling back to paginated RPC, and cached deployment block lookups to avoid redundant explorer/RPC calls.
- 2a6bd61: Added RadixHypCollateral, StarknetHypCollateral, and StarknetHypNative to TOKEN_COLLATERALIZED_STANDARDS, fixing missing collateral value metrics for Radix and Starknet warp routes.
- Updated dependencies [1f021bf]
- Updated dependencies [1f021bf]
- Updated dependencies [027eeac]
- Updated dependencies [1f021bf]
  - @hyperlane-xyz/aleo-sdk@25.4.0
  - @hyperlane-xyz/utils@25.4.0
  - @hyperlane-xyz/cosmos-sdk@25.4.0
  - @hyperlane-xyz/core@11.0.1
  - @hyperlane-xyz/provider-sdk@1.4.0
  - @hyperlane-xyz/radix-sdk@25.4.0
  - @hyperlane-xyz/deploy-sdk@1.4.0
  - @hyperlane-xyz/tron-sdk@21.1.3
  - @hyperlane-xyz/starknet-core@25.4.0

## 25.3.2

### Patch Changes

- Updated dependencies [521d42b]
  - @hyperlane-xyz/core@10.2.0
  - @hyperlane-xyz/tron-sdk@21.1.2
  - @hyperlane-xyz/deploy-sdk@1.3.6
  - @hyperlane-xyz/aleo-sdk@25.3.2
  - @hyperlane-xyz/starknet-core@25.3.2
  - @hyperlane-xyz/cosmos-sdk@25.3.2
  - @hyperlane-xyz/radix-sdk@25.3.2
  - @hyperlane-xyz/utils@25.3.2
  - @hyperlane-xyz/provider-sdk@1.3.6

## 25.3.1

### Patch Changes

- Updated dependencies [7636bb4]
  - @hyperlane-xyz/tron-sdk@21.1.1
  - @hyperlane-xyz/deploy-sdk@1.3.5
  - @hyperlane-xyz/aleo-sdk@25.3.1
  - @hyperlane-xyz/starknet-core@25.3.1
  - @hyperlane-xyz/cosmos-sdk@25.3.1
  - @hyperlane-xyz/radix-sdk@25.3.1
  - @hyperlane-xyz/utils@25.3.1
  - @hyperlane-xyz/provider-sdk@1.3.5
  - @hyperlane-xyz/core@10.1.5

## 25.3.0

### Minor Changes

- aea767c: Tron Virtual Machine (TVM) support added to the Hyperlane SDK. The new `@hyperlane-xyz/tron-sdk` package provides `TronJsonRpcProvider`, `TronWallet`, and `TronContractFactory` for interacting with Tron chains. The SDK deployers now automatically use Tron-compiled factories for Create2-affected contracts (ISM/hook factories, ICA router) when deploying to Tron chains.

### Patch Changes

- Updated dependencies [aea767c]
  - @hyperlane-xyz/tron-sdk@21.1.0
  - @hyperlane-xyz/deploy-sdk@1.3.4
  - @hyperlane-xyz/aleo-sdk@25.3.0
  - @hyperlane-xyz/starknet-core@25.3.0
  - @hyperlane-xyz/cosmos-sdk@25.3.0
  - @hyperlane-xyz/radix-sdk@25.3.0
  - @hyperlane-xyz/utils@25.3.0
  - @hyperlane-xyz/provider-sdk@1.3.4
  - @hyperlane-xyz/core@10.1.5

## 25.2.0

### Minor Changes

- 18ec479: Allow custom_rpc_header to be set for starknet chains
- 795d93e: Include gasCurrencyCoinGeckoId to coinGeckoId field created by Token.FromChainMetadataNativeToken

### Patch Changes

- 215dff0: Exported `onChainTypeToTokenFeeTypeMap` and `OnchainTokenFeeType` from SDK to support fee contract transaction reading in GovernTransactionReader.
- d2f75a1: Added retry logic for Safe Transaction Service API calls to handle 429 rate limits during multi-chain operations. Fixed signer passthrough in EV5GnosisSafeTxSubmitter.create(). Extracted shared Safe init logic to reduce duplication between EV5GnosisSafeTxSubmitter and EV5GnosisSafeTxBuilder.
- e143956: Added a 30-second minimum floor to the dynamic confirmation timeout in `MultiProvider.handleTx`, preventing unreasonably short timeouts on fast L2 chains with very small `estimateBlockTime` values.
- c61d612: Added anvil RPC helper functions (setBalance, setStorageAt, mine, increaseTime, snapshot, revertToSnapshot, impersonateAccounts) for use in E2E test harnesses.
- c2affe2: Added timeout protection to MultiProvider.handleTx() for numeric block confirmation waits. The existing timeoutMs option now applies to both numeric and block-tag confirmation paths, with a default of 5 minutes. This prevents indefinite hangs when ethers.js response.wait() fails to resolve.
- Updated dependencies [360db52]
- Updated dependencies [6091a31]
- Updated dependencies [ccd638d]
  - @hyperlane-xyz/utils@25.2.0
  - @hyperlane-xyz/aleo-sdk@25.2.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/cosmos-sdk@25.2.0
  - @hyperlane-xyz/deploy-sdk@1.3.3
  - @hyperlane-xyz/provider-sdk@1.3.3
  - @hyperlane-xyz/radix-sdk@25.2.0
  - @hyperlane-xyz/starknet-core@25.2.0

## 25.1.0

### Patch Changes

- b930534: Added oxlint as a fast first-pass linter and converted imports to type-only where appropriate to resolve import cycle warnings.
- a18d0e6: Fixed nonce collision in EvmTokenFeeModule by deploying sub-fee contracts sequentially instead of in parallel.
- Updated dependencies [b930534]
- Updated dependencies [cbd400c]
  - @hyperlane-xyz/utils@25.1.0
  - @hyperlane-xyz/radix-sdk@25.1.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/aleo-sdk@25.1.0
  - @hyperlane-xyz/cosmos-sdk@25.1.0
  - @hyperlane-xyz/deploy-sdk@1.3.2
  - @hyperlane-xyz/provider-sdk@1.3.2
  - @hyperlane-xyz/starknet-core@25.1.0

## 25.0.0

### Major Changes

- aaabbad: Added EvmXERC20Reader and EvmXERC20Module for XERC20 limit and bridge management following HyperlaneModule pattern. Supported both Standard and Velodrome XERC20 types with on-chain bridge enumeration and drift detection.

  BREAKING CHANGE: `deriveXERC20TokenType` signature changed from `(provider, address)` to `(multiProvider, chain, address)` to use SDK's `isContractAddress` utility.

### Patch Changes

- 52ce778: A `LazyAsync` helper was added to `@hyperlane-xyz/utils` for safe, deduplicated async initialization. It replaces the scattered pattern of `if (!cached) { cached = await init(); } return cached` with an approach that deduplicates concurrent callers, clears state on errors to allow retries, and supports reset capability. Consumer packages were migrated to use this utility.
- Updated dependencies [52ce778]
  - @hyperlane-xyz/utils@25.0.0
  - @hyperlane-xyz/cosmos-sdk@25.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/aleo-sdk@25.0.0
  - @hyperlane-xyz/deploy-sdk@1.3.1
  - @hyperlane-xyz/provider-sdk@1.3.1
  - @hyperlane-xyz/radix-sdk@25.0.0
  - @hyperlane-xyz/starknet-core@25.0.0

## 24.0.0

### Major Changes

- d0b8c24: Renamed EvmERC20WarpModule to EvmWarpModule.
  Renamed EvmERC20WarpRouteReader to EvmWarpRouteReader.
- 4de5071: **BREAKING**: `MetadataBuilder.build()` now returns `MetadataBuildResult` instead of `string`. Access `.metadata` on the result to get the encoded bytes.

  Added real-time validator signature status to MetadataBuilder. The builder now returns detailed information about which validators have signed a message, their checkpoint indices, and actual signatures. New exports: `ValidatorInfo`, `MetadataBuildResult`, `DerivedHookConfig`, and helper functions `isMetadataBuildable()`, `getSignedValidatorCount()`, `isQuorumMet()`.

  Performance optimizations:
  - EvmIsmReader routing ISM derivation reduced from ~5.7s to ~724ms via messageContext short-circuit
  - EvmHookReader RPC calls parallelized across all derivation methods
  - SmartProvider retry logic fixed to correctly identify permanent errors

### Minor Changes

- 9dc71fe: Added forward-compatible enum validation to prevent SDK failures when the registry contains new enum values. Added `Unknown` variants to `ProtocolType`, `TokenType`, `IsmType`, `HookType`, `ExplorerFamily`, and `ChainTechnicalStack` enums. Exported `KnownProtocolType` and `DeployableTokenType` for type-safe mappings.

### Patch Changes

- 57461b2: The arrow wrapper in fetchWithTimeout was replaced with a bound method to prevent closure from capturing surrounding scope and keeping large objects alive for the lifetime of the AbortSignal timeout. Removed duplicate dead code from SDK.
- 50868ce: Fixed HypNative token checker failing in CI environments by passing `from` address as the third parameter to `estimateGas` instead of inside the transaction object.
- b05e9f8: Fixed Mailbox instruction Borsh schema to use u8 discriminator (matching Rust's Borsh enum serialization) instead of u32.
- f44c2b4: Fixed warp check false positives for allowedRebalancingBridges when addresses are the same but in different order.
- Updated dependencies [9c52a94]
- Updated dependencies [57461b2]
- Updated dependencies [d580bb6]
- Updated dependencies [b1b941e]
- Updated dependencies [9dc71fe]
- Updated dependencies [bde05e9]
  - @hyperlane-xyz/deploy-sdk@1.3.0
  - @hyperlane-xyz/utils@24.0.0
  - @hyperlane-xyz/aleo-sdk@24.0.0
  - @hyperlane-xyz/provider-sdk@1.3.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/cosmos-sdk@24.0.0
  - @hyperlane-xyz/radix-sdk@24.0.0
  - @hyperlane-xyz/starknet-core@24.0.0

## 23.0.0

### Major Changes

- 80f3635: feat: aleo nexus ui support

### Minor Changes

- d1d90d2: Extracted shared gas estimation utilities: `estimateHandleGasForRecipient()` for `handle()` calls and `estimateCallGas()` for individual contract calls. Added `HyperlaneCore.estimateHandleGas()` accepting minimal params. Refactored `InterchainAccount.estimateIcaHandleGas()` to use shared utilities.
- 7c22cff: Added optional `blockTag` parameter to `getBridgedSupply()` method in `IHypTokenAdapter` interface and all EVM adapter implementations. This allows querying bridged supply at a specific block height or using block parameter tags (finalized, safe, latest, etc.).
- 52fd0f8: Added `estimateIcaHandleGas()` public method to estimate destination gas for ICA calls. `getCallRemote()` now extracts gasLimit from hookMetadata for accurate IGP quoting with the `quoteGasPayment(uint32,uint256)` overload. Fixed `hookMetadata` type from `BigNumber` to `string` in `GetCallRemoteSettings`.
- 6ddef74: Fix warp check for Aleo.
- 9aa93f4: Added optional `waitConfirmations` parameter to `sendTransaction()` and `handleTx()` methods in MultiProvider, which allowed callers to specify a custom number of confirmations or a block tag like "finalized" or "safe" to wait for before returning. Added `waitForBlockTag()` helper method that polled until the tagged block number reached the transaction's block number. Exported new `SendTransactionOptions` interface from SDK.
- 42b72c3: Extracted relayer into dedicated `@hyperlane-xyz/relayer` package
  - Moved `HyperlaneRelayer` class from SDK to new package
  - Moved ISM metadata builders from SDK to relayer package
  - New package supports both manual CLI execution and continuous daemon mode for K8s deployments
  - Added Prometheus metrics support with `/metrics` endpoint (enabled by default on port 9090)
  - CLI and infra now import from new package
  - **Breaking**: The following exports were removed from `@hyperlane-xyz/sdk` and are now available from `@hyperlane-xyz/relayer`:
    - `HyperlaneRelayer`, `RelayerCacheSchema`, `messageMatchesWhitelist`
    - `BaseMetadataBuilder`, `decodeIsmMetadata`
    - All metadata builder classes (`AggregationMetadataBuilder`, `MultisigMetadataBuilder`, etc.)
  - `offchainLookupRequestMessageHash` remains exported from SDK for ccip-server compatibility
  - Added `randomDeployableIsmConfig` test utility to SDK for generating deployable ISM configs with custom validators

### Patch Changes

- 52fd0f8: Fixed `getCallRemote` in InterchainAccount to query ISM using origin domain instead of destination domain. The `isms` mapping is indexed by origin (where messages come FROM), not destination.
- 576cd95: Updated `proxyAdminUpdateTxs()` to respect `ownerOverrides.proxyAdmin` when determining the expected proxyAdmin owner. The priority is now: `ownerOverrides.proxyAdmin` > `proxyAdmin.owner` > `owner`.
- a5d6cae: Fixed legacy ICA router support in InterchainAccount: use routerOverride for gas estimation and ISM lookup, and query mailbox directly for accurate quotes on legacy routers that don't support hookMetadata.
- Updated dependencies [c8f6f6c]
- Updated dependencies [0b8c4ea]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
- Updated dependencies [80f3635]
  - @hyperlane-xyz/aleo-sdk@23.0.0
  - @hyperlane-xyz/provider-sdk@1.2.1
  - @hyperlane-xyz/deploy-sdk@1.2.1
  - @hyperlane-xyz/utils@23.0.0
  - @hyperlane-xyz/cosmos-sdk@23.0.0
  - @hyperlane-xyz/radix-sdk@23.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/starknet-core@23.0.0

## 22.0.0

### Minor Changes

- 4c58992: Added `custom_rpc_header` query parameter support to SmartProvider, matching Rust agent behavior from PR #5379. This enables reusing the same authenticated RPC URLs across both TypeScript and Rust tooling. Header values are redacted in stored config for logging safety while real values are passed to ethers for authentication.
- b0e9d48: Introduced artifact-based IsmWriter and migrated existing code to use it instead of AltVMIsmModule.
- 7f31d77: Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.

### Patch Changes

- c6a6d5f: Fix CCTP warp route ISM derivation
- 99948bc: Fixed EvmTokenFeeModule to derive routingDestinations from target config when not explicitly provided. This ensures sub-fee contracts are properly read from on-chain when updating RoutingFee configurations. Also added support for deploying new sub-fee contracts when adding destinations to an existing RoutingFee.
- 99948bc: Fixed warp apply idempotency issue where re-running after partial failure would fail with UNPREDICTABLE_GAS_LIMIT error when ownership had already been transferred. The setFeeRecipient transaction is now only generated when the fee recipient actually needs to change.
- 66ef635: Added `mapAllSettled` helper to @hyperlane-xyz/utils for typed parallel operations with key-based error tracking. Migrated Promise.allSettled patterns across sdk, cli, infra, and rebalancer packages to use the new helper.
- 7a0a9e4: Fix `RoutingFee` deployment when the configured owner differs from the deployer signer, and avoid requiring routing destinations when deriving `RoutingFee` configs during warp deploy.
- Updated dependencies [ade2653]
- Updated dependencies [8b3f8da]
- Updated dependencies [0acaa0e]
- Updated dependencies [7f31d77]
- Updated dependencies [b0e9d48]
- Updated dependencies [b0e9d48]
- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
- Updated dependencies [44fbfd6]
  - @hyperlane-xyz/aleo-sdk@22.0.0
  - @hyperlane-xyz/cosmos-sdk@22.0.0
  - @hyperlane-xyz/deploy-sdk@1.2.0
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/provider-sdk@1.2.0
  - @hyperlane-xyz/radix-sdk@22.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/starknet-core@22.0.0

## 21.1.0

### Patch Changes

- Updated dependencies [db857b5]
- Updated dependencies [57a2053]
- Updated dependencies [57a2053]
- Updated dependencies [9c48ac8]
  - @hyperlane-xyz/cosmos-sdk@21.1.0
  - @hyperlane-xyz/provider-sdk@1.1.0
  - @hyperlane-xyz/aleo-sdk@21.1.0
  - @hyperlane-xyz/deploy-sdk@1.1.0
  - @hyperlane-xyz/radix-sdk@21.1.0
  - @hyperlane-xyz/starknet-core@21.1.0
  - @hyperlane-xyz/utils@21.1.0
  - @hyperlane-xyz/core@10.1.5

## 21.0.0

### Major Changes

- 68310db: feat: aleo cli support

### Minor Changes

- bc8b22f: Moved rebalancer-specific type definitions from `@hyperlane-xyz/sdk` to `@hyperlane-xyz/rebalancer`. Updated CLI and infra imports to use the new location. The rebalancer package is now self-contained and doesn't pollute the SDK with rebalancer-specific types.

### Patch Changes

- c08fa32: Added default multisig ISM validator configs for eni and krown chains. Improved deployer contract verification to gracefully skip when no explorer API is configured instead of failing.
- b6b206d: Fixed CCTP V2 deployer to allow maxFeeBps and minFinalityThreshold to be 0 by using explicit undefined checks instead of falsy checks.
- ed10fc1: Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.
- Updated dependencies [8006faf]
- Updated dependencies [68310db]
- Updated dependencies [239e1a1]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/aleo-sdk@21.0.0
  - @hyperlane-xyz/deploy-sdk@1.0.0
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/radix-sdk@21.0.0
  - @hyperlane-xyz/cosmos-sdk@21.0.0
  - @hyperlane-xyz/utils@21.0.0
  - @hyperlane-xyz/core@10.1.4
  - @hyperlane-xyz/starknet-core@21.0.0

## 20.1.0

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
  - @hyperlane-xyz/deploy-sdk@0.7.0
  - @hyperlane-xyz/core@10.1.3
  - @hyperlane-xyz/starknet-core@20.1.0

## 20.0.0

### Major Changes

- a7dc73d: Allow for the 0 chain id

### Patch Changes

- Updated dependencies [b3ebc08]
- Updated dependencies [aeac943]
  - @hyperlane-xyz/utils@20.0.0
  - @hyperlane-xyz/provider-sdk@0.6.0
  - @hyperlane-xyz/core@10.1.2
  - @hyperlane-xyz/cosmos-sdk@20.0.0
  - @hyperlane-xyz/deploy-sdk@0.6.0
  - @hyperlane-xyz/radix-sdk@20.0.0
  - @hyperlane-xyz/starknet-core@20.0.0

## 19.13.0

### Patch Changes

- 3592f258a: Fix StarknetHypCollateralAdapter to use StarknetTokenAdapter for wrappedTokenAdapter instead of synthetic adapter
- Updated dependencies [ae8ef4389]
- Updated dependencies [ae8ef4389]
  - @hyperlane-xyz/radix-sdk@19.13.0
  - @hyperlane-xyz/deploy-sdk@0.5.0
  - @hyperlane-xyz/starknet-core@19.13.0
  - @hyperlane-xyz/cosmos-sdk@19.13.0
  - @hyperlane-xyz/utils@19.13.0
  - @hyperlane-xyz/provider-sdk@0.5.0
  - @hyperlane-xyz/core@10.1.1

## 19.12.0

### Minor Changes

- 38a1165c8: - Update CLI context `altVmSigners` to be a `ChainMap` instead of `AltVMSignerFactory`,
  - Update CLI context `altVmProviders` to be a `ChainMap` instead of `AltVMSignerFactory`.
  - Update all existing getter methods to use `mustTry`, instead of `assert`.
  - Delete `AltVMSupportedProtocols` and `AltVMProviderFactory`.
  - Move functions from `AltVMSignerFactory` to top-level functions.
  - Add `getMinGas` to Aleo, Cosmos and Radix ProtocolProvider.
- af2cd1729: Support reading ReorgEvent object from validator buckets.
- 08cf7eca9: Check for implementation contract for `contractInstance` and fallback to `balanceOf` if `balance_of` does not exist

### Patch Changes

- 618615dc4: Fix SmartProvider to retry on CALL_EXCEPTION errors without revert data. Previously, CALL_EXCEPTION errors would immediately stop provider fallback even when caused by RPC issues rather than actual on-chain reverts. Now, CALL_EXCEPTION errors without revert data (or with empty "0x" data) are treated as transient RPC errors and will trigger fallback to the next provider.
- Updated dependencies [38a1165c8]
- Updated dependencies [08cf7eca9]
- Updated dependencies [77524f734]
- Updated dependencies [af2cd1729]
- Updated dependencies [43b3756d9]
- Updated dependencies [e37100e2e]
  - @hyperlane-xyz/provider-sdk@0.4.0
  - @hyperlane-xyz/cosmos-sdk@19.12.0
  - @hyperlane-xyz/radix-sdk@19.12.0
  - @hyperlane-xyz/utils@19.12.0
  - @hyperlane-xyz/core@10.1.0
  - @hyperlane-xyz/deploy-sdk@0.4.0
  - @hyperlane-xyz/starknet-core@19.12.0

## 19.11.0

### Minor Changes

- 156a37d6e: Fixed the `EV5GnosisSafeTxSubmitter` which failed to create the SAFE transactions due to incorrect typing of the SAFE sdk classes not surfacing incorrect function params when calling `Safe.createTransaction`

### Patch Changes

- 4c29cd341: Fix zkSync ICA compatibility and add storage ISM support in metadata builder
- Updated dependencies [dd6260eea]
- Updated dependencies [dd6260eea]
  - @hyperlane-xyz/provider-sdk@0.3.0
  - @hyperlane-xyz/radix-sdk@19.11.0
  - @hyperlane-xyz/cosmos-sdk@19.11.0
  - @hyperlane-xyz/deploy-sdk@0.3.0
  - @hyperlane-xyz/starknet-core@19.11.0
  - @hyperlane-xyz/utils@19.11.0
  - @hyperlane-xyz/core@10.0.5

## 19.10.0

### Minor Changes

- c2a64e8c5: feat: add setTokenHook to altvm interface
- a97a9939c: Fix core deployment on cosmos chains failing as the ism was not set properly on mailbox creation
- 66bed7126: migrated AltVm modules to provider-sdk and deploy-sdk
- f604423b9: - Remove AltVMProviderFactory to new API in deploy-sdk (loadlProtocolProviders) and Registry singleton.
  - Add `chainId` and `rpcUrls` to `ChainMetadataForAltVM`. Add `CosmosNativeProtocolProvider` and `RadixProtocolProvider` to both cosmos-sdk and radix-sdk, respectively.
  - Add `forWarpRead`, `forCoreRead`, and `forCoreCheck` to signerMiddleware to enable chain resolving for these CLI functions.
  - Add `assert` after some `altVmProvider.get` calls in SDK configUtils.

### Patch Changes

- b2a693ac6: corrected gas overhead values for nativeScaled token type
- c0583af62: Improve CCTP offchain lookup server error handling
- 9770b732c: Fix handling of malformed getStorageAt responses from RPC providers (e.g., Somnia) that return empty hex strings.
- 43ecd628c: updated the ISM schema to allow STORAGE_AGGREGATION type that was already supported
- Updated dependencies [aad2988c9]
- Updated dependencies [c2a64e8c5]
- Updated dependencies [6cfde25d8]
- Updated dependencies [a97a9939c]
- Updated dependencies [a0ba5e2fb]
- Updated dependencies [66bed7126]
- Updated dependencies [29ad1d225]
- Updated dependencies [f604423b9]
  - @hyperlane-xyz/utils@19.10.0
  - @hyperlane-xyz/deploy-sdk@0.2.0
  - @hyperlane-xyz/cosmos-sdk@19.10.0
  - @hyperlane-xyz/radix-sdk@19.10.0
  - @hyperlane-xyz/core@10.0.4
  - @hyperlane-xyz/provider-sdk@0.2.0
  - @hyperlane-xyz/starknet-core@19.10.0

## 19.9.0

### Patch Changes

- 8c027d852: Fixed SmartProvider fallback logic to stop retrying on blockchain errors
- Updated dependencies [8c027d852]
  - @hyperlane-xyz/utils@19.9.0
  - @hyperlane-xyz/core@10.0.3
  - @hyperlane-xyz/cosmos-sdk@19.9.0
  - @hyperlane-xyz/radix-sdk@19.9.0
  - @hyperlane-xyz/starknet-core@19.9.0

## 19.8.0

### Minor Changes

- 500d81246: Add turnkey dependencies and create signers for EVM, SVM.
- 78ff6cd47: add new methods for altvm interface

### Patch Changes

- 4614a503e: Allow both xerc20 and collateral types in xerc20 config validation.
- 00b014a3e: fix sdk regression that prevented warp tokens pre-fee support to be derived when deriving on chain config
- Updated dependencies [2ed21c97d]
- Updated dependencies [78ff6cd47]
- Updated dependencies [3f75ad86d]
  - @hyperlane-xyz/utils@19.8.0
  - @hyperlane-xyz/cosmos-sdk@19.8.0
  - @hyperlane-xyz/radix-sdk@19.8.0
  - @hyperlane-xyz/core@10.0.2
  - @hyperlane-xyz/starknet-core@19.8.0

## 19.7.0

### Minor Changes

- 69ad3473e: Implemented the getMetadata method on native token adapters and fixed the populateTransferTx method for SVM token adapters when the receiver does not have a created associated token account
- 211e245cb: Create EvmHypBaseCollateralAdapter, now EvmHypCollateralAdapter and EvmHypRebaseCollateralAdapter extends from it
- c68722d93: Update fetchPackageVersion() to return 0.0.0 when unknown error is thrown. This error is logged out and is no longer rethrown.

### Patch Changes

- bdfa2047e: Fix CCTP v2 deployer constructor argument encoding
- 343737271: Assert code exists on eth_storageAt requests
- 5c4cef1d4: Fixed a bug where EvmHypCollateralAdapter:getWrappedTokenAddress() would not return the correct address if the route had the old versions. Add fallback for contract.getPackageVersion()
  - @hyperlane-xyz/starknet-core@19.7.0
  - @hyperlane-xyz/cosmos-sdk@19.7.0
  - @hyperlane-xyz/radix-sdk@19.7.0
  - @hyperlane-xyz/utils@19.7.0
  - @hyperlane-xyz/core@10.0.1

## 19.6.0

### Minor Changes

- e67aca4a1: Update type to enforce consistency between fee token addresses and warp route token addresses through schema validation. The main change adds validation logic to ensure tokenFee.token matches config.token for collateral token configurations.
- 419e16910: Add support for deploying and updating the EverclearEthBridge and EverclearTokenBridge contracts
- b259966fe: Add the Fee deploy logic into token deployer to allow warp routes to deploy with a token fee. Update Fee schemas to separate between input and output
- ec406fcbe: Add TokenFee updates to the FeeModule and WarpModule. This enables updating immutable fees (re-deploy), routing sub-fees, and ownership
- 18c32ed2b: Decouple movable collateral and hyp collateral token adapters
- b259966fe: Implement EvmTokenFeeModule and Reader for Linear and Routing Fees. Update Fee Schemas to include both input and output configs.
- 9185b9c5b: Update EvmTokenFeeModule to support native fee deployment by extracting config processing into a static method that handles native tokens, modularizing deployment logic, and adding automatic BPS calculation from fee parameters.

### Patch Changes

- e0c69e255: Implement token fees on FungibleTokenRouter

  Removes `metadata` from return type of internal `TokenRouter._transferFromSender` hook

  To append `metadata` to `TokenMessage`, override the `TokenRouter._beforeDispatch` hook

- Updated dependencies [7a41068f7]
- Updated dependencies [18c32ed2b]
- Updated dependencies [205bcae75]
- Updated dependencies [f8da8cd40]
- Updated dependencies [5b17b0f37]
- Updated dependencies [2c6506735]
- Updated dependencies [1d46a826d]
- Updated dependencies [799751606]
- Updated dependencies [826e83741]
- Updated dependencies [e0c69e255]
- Updated dependencies [737ea2b35]
- Updated dependencies [e0c69e255]
- Updated dependencies [dd16e3df4]
- Updated dependencies [f930794d7]
- Updated dependencies [419e16910]
- Updated dependencies [9a43cdca9]
  - @hyperlane-xyz/core@10.0.0
  - @hyperlane-xyz/utils@19.6.0
  - @hyperlane-xyz/cosmos-sdk@19.6.0
  - @hyperlane-xyz/radix-sdk@19.6.0
  - @hyperlane-xyz/starknet-core@19.6.0

## 19.5.0

### Minor Changes

- 312826d10: - Updated DerivedCoreConfig type to properly type the defaultIsm field with the DerivedIsmConfig type
  - Fixed AltVMIsmModule not transferring ownership to the expected owner in the deploy config after deployment
- bf2c2caa6: Updated the EvmHypCollateralFiatAdapter to not break if the underlying mintable contract does not define a minterAllowance method
- 79a51debe: Update all @safe-global dependencies to latest, to support usage of Safe API Keys. Add gnosisSafeApiKey to chain metadata schema.

### Patch Changes

- Updated dependencies [312826d10]
- Updated dependencies [312826d10]
  - @hyperlane-xyz/utils@19.5.0
  - @hyperlane-xyz/radix-sdk@19.5.0
  - @hyperlane-xyz/core@9.0.17
  - @hyperlane-xyz/cosmos-sdk@19.5.0
  - @hyperlane-xyz/starknet-core@19.5.0

## 19.4.0

### Minor Changes

- 4011a4561: Fix bug that prevented the warp route ism to be set to the 0 address and include logic to update a pausable ism as it was missing
- 8fd3bf78c: Fixed critical schema bug where SealevelIgpData.gas_oracles was incorrectly typed as Map<number, bigint> instead of Map<number, SealevelGasOracle>, preventing proper deserialization of on-chain gas oracle state. Added SealevelRemoteGasData, SealevelGasOracle, and related Borsh schemas to match the Rust implementation. Implemented createSetGasOracleConfigsInstruction() and createSetDestinationGasOverheadsInstruction() methods on the IGP adapters, along with gasOracleMatches() helper with BigInt-safe comparison for detecting configuration drift between expected and actual on-chain values.
- 79f55e09d: Export WarpCoreFeeEstimate
- 5a4e22d34: Introduced new SvmTransactionSigner interface, rewrite SvmMultiprotocolSignerAdapter to leverage this interface. Add more robust tx sending and handling to SvmMultiprotocolSignerAdapter. Implement KeypairSvmTransactionSigner to handle the general PK/keypair-based tx signing.

### Patch Changes

- 5a4e22d34: Bump @solana/web3.js dependency explicitly from ^1.95.4 to ^1.98.4.
- 517bbaa42: Update NON_ZERO_SENDER_ADDRESS to 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba.
- Updated dependencies [5a4e22d34]
  - @hyperlane-xyz/utils@19.4.0
  - @hyperlane-xyz/core@9.0.16
  - @hyperlane-xyz/starknet-core@19.4.0
  - @hyperlane-xyz/cosmos-sdk@19.4.0
  - @hyperlane-xyz/radix-sdk@19.4.0

## 19.3.0

### Minor Changes

- fcdda58a8: Update hardcoded `originTokenAmount` of getLocalTransferFee from 1 to 2 wei.

### Patch Changes

- @hyperlane-xyz/starknet-core@19.3.0
- @hyperlane-xyz/cosmos-sdk@19.3.0
- @hyperlane-xyz/radix-sdk@19.3.0
- @hyperlane-xyz/utils@19.3.0
- @hyperlane-xyz/core@9.0.15

## 19.2.0

### Minor Changes

- f68419605: Update Warp Reader to set `token` to underlying `vault` instead of `wrappedToken` for yield routes. Update Checker to return the vault's `asset` as the collateral token.

### Patch Changes

- @hyperlane-xyz/starknet-core@19.2.0
- @hyperlane-xyz/cosmos-sdk@19.2.0
- @hyperlane-xyz/radix-sdk@19.2.0
- @hyperlane-xyz/utils@19.2.0
- @hyperlane-xyz/core@9.0.14

## 19.1.1

### Patch Changes

- @hyperlane-xyz/starknet-core@19.1.1
- @hyperlane-xyz/cosmos-sdk@19.1.1
- @hyperlane-xyz/radix-sdk@19.1.1
- @hyperlane-xyz/utils@19.1.1
- @hyperlane-xyz/core@9.0.13

## 19.1.0

### Minor Changes

- 554ff1a66: Add M0 PortalLite token adapter support for bridging M tokens
  - Add new TokenStandard.EvmM0PortalLite for M0 Portal integration
  - Implement M0PortalLiteTokenAdapter for handling M0 token transfers
  - Support for M0's transferMLikeToken function to bridge wrapped M tokens (e.g., mUSD)
  - Built-in gas estimation via Portal's quoteTransfer function

### Patch Changes

- @hyperlane-xyz/starknet-core@19.1.0
- @hyperlane-xyz/cosmos-sdk@19.1.0
- @hyperlane-xyz/radix-sdk@19.1.0
- @hyperlane-xyz/utils@19.1.0
- @hyperlane-xyz/core@9.0.12

## 19.0.0

### Major Changes

- e42a0e8e1: feat: radix support for the cli
- 32479e139: feat: implement new AltVM modules and readers

### Minor Changes

- 8eab305bd: chore: add transactionToPrintableJson to altvm interface

### Patch Changes

- 70354d6d9: Restore foreignDeployment field behaviour to allow enrollment of unsupported chains during deployment
- dd4928b1c: chore: refactor altvm warp module and add tests
- Updated dependencies [8eab305bd]
- Updated dependencies [e42a0e8e1]
- Updated dependencies [e42a0e8e1]
- Updated dependencies [32479e139]
- Updated dependencies [32479e139]
  - @hyperlane-xyz/cosmos-sdk@19.0.0
  - @hyperlane-xyz/radix-sdk@19.0.0
  - @hyperlane-xyz/utils@19.0.0
  - @hyperlane-xyz/core@9.0.11
  - @hyperlane-xyz/starknet-core@19.0.0

## 18.3.0

### Minor Changes

- 4974e66a0: export radix core reader
- 30ec5ffbb: Add signer abstraction for different protocol types by defining the IMultiProtocolSigner interface
- b66129ee2: export radix hook reader
- 2c47e1143: Update the `ContractVerifier` class to avoid verification of already verified contracts and to show verification errors in debug logs
- 2b16904f8: Add getBridgedSupply to EvmHypNativeAdapter to return the native token balance as collateral
- 096389aea: Fix a bug in the `EvmIcaTxSubmitter.submit` method which failed when the evm chain id and the hyperlane domain id are different
- e4e6a75a8: export radix hook module
- 6b8419370: export radix ism module
- 94e7116c2: export RadixIsmTypes enum to consumers

### Patch Changes

- 57cf9e953: now token.isFungibleWith() will also check for isHypNative() tokens
- ee7c7ade4: Avoid extra Safe API call when only creating local JSON files for manual upload. When proposing, the Safe UI will automatically update the tx nonce. So we can return 0 and save ourselves from Safe API unreliability.
- Updated dependencies [e5a530e43]
- Updated dependencies [a5728818f]
- Updated dependencies [c41bc3b93]
- Updated dependencies [2c47e1143]
- Updated dependencies [b66129ee2]
- Updated dependencies [6b8419370]
  - @hyperlane-xyz/radix-sdk@18.3.0
  - @hyperlane-xyz/core@9.0.10
  - @hyperlane-xyz/utils@18.3.0
  - @hyperlane-xyz/starknet-core@18.3.0
  - @hyperlane-xyz/cosmos-sdk@18.3.0

## 18.2.0

### Minor Changes

- fed6906e4: Include isHypNative() check to Token and add PROTOCOL_TO_HYP_NATIVE_STANDARD
- ca64e73cd: Update the oXAUT bridge limits for avax, celo, ethereum, worldchain and base config. Export XERC20LimitsTokenConfig.
- dfa9d368c: exposed a `isJsonRpcSubmitterConfig` function to validate submitter configurations and assert the type

### Patch Changes

- Updated dependencies [dfa9d368c]
  - @hyperlane-xyz/cosmos-sdk@18.2.0
  - @hyperlane-xyz/starknet-core@18.2.0
  - @hyperlane-xyz/radix-sdk@18.2.0
  - @hyperlane-xyz/utils@18.2.0
  - @hyperlane-xyz/core@9.0.9

## 18.1.0

### Patch Changes

- 73be9b8d2: Don't use radix-engine-toolkit for frontend application usage.
- Updated dependencies [73be9b8d2]
  - @hyperlane-xyz/radix-sdk@18.1.0
  - @hyperlane-xyz/starknet-core@18.1.0
  - @hyperlane-xyz/cosmos-sdk@18.1.0
  - @hyperlane-xyz/utils@18.1.0
  - @hyperlane-xyz/core@9.0.8

## 18.0.0

### Major Changes

- 552b253b9: deprecated dry-run support in the cli in favour of `hyperlane warp fork` and `hyperlane fork` commands

### Patch Changes

- ba832828f: Made decimals consistency check scale-aware and disallowed partial decimals across chains
- Updated dependencies [cfc0eb2a7]
  - @hyperlane-xyz/utils@18.0.0
  - @hyperlane-xyz/core@9.0.7
  - @hyperlane-xyz/radix-sdk@18.0.0
  - @hyperlane-xyz/starknet-core@18.0.0
  - @hyperlane-xyz/cosmos-sdk@18.0.0

## 17.0.0

### Major Changes

- 8c15edc67: Added Radix Protocol Type

### Minor Changes

- 400c02460: Add fallback logic to the `EvmEventLogsReader` to use the rpc when the block explorer api request fails
- 6583df016: Add the getPendingScheduledOperations and getPendingOperationIds methods on the EvmTimelockReader class and export getTimelockExecutableTransactionFromBatch from sdk

### Patch Changes

- 76a5db49a: Fixed a bug when deriving token metadata from chain was erasing existing fields from deployment config
- 7f542b288: Fix `CosmosModuleTokenAdapter` recipient conversion for populateTransferRemoteTx
- Updated dependencies [8c15edc67]
- Updated dependencies [e0bda316a]
  - @hyperlane-xyz/utils@17.0.0
  - @hyperlane-xyz/core@9.0.6
  - @hyperlane-xyz/starknet-core@17.0.0
  - @hyperlane-xyz/cosmos-sdk@17.0.0

## 16.2.0

### Minor Changes

- 22ceaa109: Add xERC20 adapter with getLimits()
- a89018a3f: Make `getWrappedTokenAddress` public, add LOCKBOX_STANDARDS

### Patch Changes

- ce4974214: Add cctp to getActualDecimals.
  - @hyperlane-xyz/starknet-core@16.2.0
  - @hyperlane-xyz/cosmos-sdk@16.2.0
  - @hyperlane-xyz/utils@16.2.0
  - @hyperlane-xyz/core@9.0.5

## 16.1.1

### Patch Changes

- ea77b6ae4: Add Starknet protocol type.
  - @hyperlane-xyz/starknet-core@16.1.1
  - @hyperlane-xyz/cosmos-sdk@16.1.1
  - @hyperlane-xyz/utils@16.1.1
  - @hyperlane-xyz/core@9.0.4

## 16.1.0

### Minor Changes

- 2a2c29c39: Add the `EvmTimelockReader` class to get pending/scheduled transaction from a timelock contract. Add the `EvmEventLogsReader` to read logs on a given chain reliably either using the rpc or the block explorer api depending on what is available in the registry

### Patch Changes

- e69ac9f62: Updated the HypERC20Checker to use a default anvil address instead of the signer address when asserting if a token is a hyp native
- d9b8a7551: Handle etherscan v2 api migration
  - @hyperlane-xyz/starknet-core@16.1.0
  - @hyperlane-xyz/cosmos-sdk@16.1.0
  - @hyperlane-xyz/utils@16.1.0
  - @hyperlane-xyz/core@9.0.3

## 16.0.0

### Major Changes

- d200acfa8: Add support for submitting transactions using Timelock contracts
- 1f4412909: Remove a circular import dependency between the sdk and registry package by not importing the IRegistry interface in the sdk

### Minor Changes

- 9f3222962: Add limit check for EvmCollateralFiat tokens
- a71193486: Implemented class for deploying timelocks
- af783be54: Updated the timelock deployer class to allow configuration of cancellers on contract deployment

### Patch Changes

- 966ad8440: Fix Starknet Adapter: balance_of
- fabb4a5af: Introduced a shared eslint configuration that is applied to the SDK
  - @hyperlane-xyz/starknet-core@16.0.0
  - @hyperlane-xyz/cosmos-sdk@16.0.0
  - @hyperlane-xyz/utils@16.0.0
  - @hyperlane-xyz/core@9.0.2

## 15.0.0

### Minor Changes

- e0ea8910c: Add FileSubmitter to CLI. Export ChainSubmissionStrategySchema preprocess and superRefine. Some additional updates to types related to these changes.

### Patch Changes

- 23861b70a: Don't `handleTx` for zksync, since the zksync deployer itself will handle it.
- a33c8abd4: Use `convertToScaledAmount` in WarpCore
- d16a853c0: Update paradex AW validator address.
- Updated dependencies [451f3f6c3]
- Updated dependencies [a33c8abd4]
  - @hyperlane-xyz/utils@15.0.0
  - @hyperlane-xyz/core@9.0.1
  - @hyperlane-xyz/starknet-core@15.0.0
  - @hyperlane-xyz/cosmos-sdk@15.0.0

## 14.4.0

### Minor Changes

- dce47e7b6: Update getSubmitter() to be return the default set of submitters, and also allow an extension to it.

### Patch Changes

- Updated dependencies [155f5a5e8]
  - @hyperlane-xyz/core@9.0.0
  - @hyperlane-xyz/starknet-core@14.4.0
  - @hyperlane-xyz/cosmos-sdk@14.4.0
  - @hyperlane-xyz/utils@14.4.0

## 14.3.0

### Minor Changes

- 9cc7ef6fd: Add `scale` to Token Schema and account for scaling in `WarpCore.isDestinationCollateralSufficient`
- ae0771d9e: Minor refactoring to deduplicate ism/router overrides passed into the InterchainAccount app.

### Patch Changes

- ae0771d9e: InterchainAccount.getCallRemote now respects the localRouter override if passed in.
  - @hyperlane-xyz/starknet-core@14.3.0
  - @hyperlane-xyz/cosmos-sdk@14.3.0
  - @hyperlane-xyz/utils@14.3.0
  - @hyperlane-xyz/core@8.1.2

## 14.2.0

### Minor Changes

- 3122bae93: Add support for updating the required and default hooks in core deployments
- 3e50bd7f0: Modify IGP schema to include the optional typical cost in the schema
- 147dd360a: add cosmosnative warp deploy sdk logic
- 8bde1544e: Add helper function for determining if a given address is a ProxyAdmin.

### Patch Changes

- a7d5941c1: Fix Starknet total_supply.
- Updated dependencies [c177c4733]
  - @hyperlane-xyz/core@8.1.1
  - @hyperlane-xyz/starknet-core@14.2.0
  - @hyperlane-xyz/cosmos-sdk@14.2.0
  - @hyperlane-xyz/utils@14.2.0

## 14.1.0

### Minor Changes

- ecaa4ef90: Add ownerStatus virtual config to `warp check`, which checks the proxy, implementation, and proxy admin owners. Add ISafe and IOwnerManager. Also, refactor contractVerificationStatus slightly

### Patch Changes

- bd91094c3: Remove package.json imports and use CONTRACTS_PACKAGE_VERSION directly where necessary.
- Updated dependencies [bd91094c3]
- Updated dependencies [04fc563f4]
- Updated dependencies [ecaa4ef90]
  - @hyperlane-xyz/core@8.1.0
  - @hyperlane-xyz/starknet-core@14.1.0
  - @hyperlane-xyz/cosmos-sdk@14.1.0
  - @hyperlane-xyz/utils@14.1.0

## 14.0.0

### Major Changes

- 66c13b539: Updated ICA transaction support for allowing the CLI to send them when provided with the appropriate strategy config

### Patch Changes

- 929708c1f: Respect the expectedRemoteChains arg when checking enrolled routers in HyperlaneRouterChecker.
- 88134de1f: Enable backwards-compatible ISM derivation with legacy ICAs.
- 7ad8e394c: fix starknet token adapter
- Updated dependencies [7ad8e394c]
  - @hyperlane-xyz/utils@14.0.0
  - @hyperlane-xyz/core@8.0.2
  - @hyperlane-xyz/starknet-core@14.0.0
  - @hyperlane-xyz/cosmos-sdk@14.0.0

## 13.4.0

### Minor Changes

- 5f60deed3: add cosmos warp read logic in sdk
- 0ec92f775: Update starknet dependency from v6 to v7.
- e48e5346f: add warp fork and fork commands
- fe1d8ab2d: Remove SG-1 from manta, neutron validators. Add botanix, katana, paradex, starknet validators. Remove arthera, corn, glue, trumpchain.
- 19384e74b: sdk support for cosmos hyperlane module v1.0.1
- 1efce4979: Add rebalancer config schemas

### Patch Changes

- 779df446d: Fix typo DomaingRoutingIsm -> DomainRoutingIsm.
- 64092311c: Update SmartProvider to throw with `cause` and update Warp Reader to use the thrown `cause`
- Updated dependencies [0ec92f775]
- Updated dependencies [19384e74b]
- Updated dependencies [ec8d196d9]
- Updated dependencies [bacf16a80]
  - @hyperlane-xyz/utils@13.4.0
  - @hyperlane-xyz/starknet-core@13.4.0
  - @hyperlane-xyz/cosmos-sdk@13.4.0
  - @hyperlane-xyz/core@8.0.1

## 13.3.0

### Minor Changes

- 509a0dc: Add partial support for the ICA router ISM to derive its on chain config when deployed and included in the config
- f8fd7b4: Support using MultiSend when proposing txs via the EV5GnosisSafeTxSubmitter.
- 6fa767e: Added option to configure rebalancers and allowed bridges for movable collateral tokens using the cli and sdk

### Patch Changes

- 119a1a8: Remove `accountOwners` from `InterchainAccountRouter`

  This reverse mapping was intended to index from a given proxy account what the corresponding derivation inputs were.

  However, this implied 2 cold SSTORE instructions per account creation.

  Instead, the `InterchainAccountCreated` event can be used which now has an `indexed` account key to filter by.

- 1e137df: Improved logging around fetching prices from CoinGecko
- Updated dependencies [e61bd2f]
- Updated dependencies [db19435]
- Updated dependencies [b977a28]
- Updated dependencies [fd3bb39]
- Updated dependencies [4544120]
- Updated dependencies [7a3165f]
- Updated dependencies [119a1a8]
- Updated dependencies [b977a28]
- Updated dependencies [88fe35f]
- Updated dependencies [3327a6e]
  - @hyperlane-xyz/core@8.0.0
  - @hyperlane-xyz/starknet-core@13.3.0
  - @hyperlane-xyz/cosmos-sdk@13.3.0
  - @hyperlane-xyz/utils@13.3.0

## 13.2.1

### Patch Changes

- 72887f7: Update to ethers v5.8.0.
- Updated dependencies [72887f7]
  - @hyperlane-xyz/utils@13.2.1
  - @hyperlane-xyz/core@7.1.10
  - @hyperlane-xyz/starknet-core@13.2.1
  - @hyperlane-xyz/cosmos-sdk@13.2.1

## 13.2.0

### Minor Changes

- 4d66b73: Add support for address in voyager block explorers
- 4d66b73: Support for zksync on deployments and verifications
- 4d66b73: Check for ZKSync contracts and functionalities support
- 4d66b73: Add ZKSync contract verification with custom compiler options and refactor verification classes
- 4d66b73: Add getTokenCollateral to WarpCore and reuse in isDestinationCollateralSufficient
- 4d66b73: Update concurrentDeploy default to true for token deployments.

### Patch Changes

- 4d66b73: Account for zksync in legacy deployer logic.
  - @hyperlane-xyz/starknet-core@13.2.0
  - @hyperlane-xyz/cosmos-sdk@13.2.0
  - @hyperlane-xyz/utils@13.2.0
  - @hyperlane-xyz/core@7.1.9

## 13.1.1

### Patch Changes

- ba4deea: Revert workspace dependency syntax.
- Updated dependencies [ba4deea]
  - @hyperlane-xyz/cosmos-sdk@13.1.1
  - @hyperlane-xyz/core@7.1.8
  - @hyperlane-xyz/starknet-core@13.1.1
  - @hyperlane-xyz/utils@13.1.1

## 13.1.0

### Minor Changes

- 6e86efa: Remove `defaultRpcConsensusType` from the agent config schema
- c42ea09: Deploy to new chains: neuratestnet, rometestnet.

### Patch Changes

- Updated dependencies [f41f766]
  - @hyperlane-xyz/utils@13.1.0
  - @hyperlane-xyz/core@7.1.7
  - @hyperlane-xyz/starknet-core@13.1.0
  - @hyperlane-xyz/cosmos-sdk@13.1.0

## 13.0.0

### Minor Changes

- 72b90f8: add cosmos native core module & reader
- bc58283: feat: Starknet SDK logic integration
- 2724559: add cosmos native routing ism cosmos-sdk and types

### Patch Changes

- Updated dependencies [0de63e0]
- Updated dependencies [f8696c7]
- Updated dependencies [2724559]
  - @hyperlane-xyz/utils@13.0.0
  - @hyperlane-xyz/starknet-core@13.0.0
  - @hyperlane-xyz/cosmos-sdk@13.0.0
  - @hyperlane-xyz/core@7.1.6

## 12.6.0

### Minor Changes

- 76f0eba: Add Cosmos Native ISM Reader & Module
- 2ae0f72: Add contract verification to CLI Warp Checker
- 672d6d1: adds logic to expand an ism or hook config if it is partially defined in the input file for the warp checker
- 1f370e6: Add HookModule.resolveHookAddresses() to resolve all HookConfig addresses
- 6a70b8d: Move executeDeploy logic from CLI to SDK
- d182d7d: Adds the sortArraysInObject function to properly sort arrays in an object recursively given an optional sort function
- 248d2e1: Enables the CLI to warp check routes that include non EVM routes
- e2a4727: Deploy to new chains: ontology, miraclechain, kyve.
- b360802: Add the isCosmosIbcDenomAddress function and improve the config expansion logic to correctly format the destination gas
- 31ee1c6: Adds fiatCollateral token on chain config derivation logic as it was incorrectly inferred as collateral
- a36d5c1: add cosmos native hook module & reader

### Patch Changes

- 7d56f2c: Pass remote chain to adjustForPrecisionLoss for better error logging
- f6ed6ad: Fixed proxy admin ownership transfer logic when the config is not specified in the input file
- Updated dependencies [76f0eba]
- Updated dependencies [d182d7d]
- Updated dependencies [b360802]
  - @hyperlane-xyz/cosmos-sdk@12.6.0
  - @hyperlane-xyz/utils@12.6.0
  - @hyperlane-xyz/core@7.1.5

## 12.5.0

### Patch Changes

- c8ace88: Export HypTokenRouterConfigMailboxOptionalSchema and HypTokenRouterConfigMailboxOptional
  - @hyperlane-xyz/cosmos-sdk@12.5.0
  - @hyperlane-xyz/utils@12.5.0
  - @hyperlane-xyz/core@7.1.4

## 12.4.0

### Minor Changes

- d2babb7: Remove fallback logic to derive extra lockboxes from rpc

### Patch Changes

- @hyperlane-xyz/cosmos-sdk@12.4.0
- @hyperlane-xyz/utils@12.4.0
- @hyperlane-xyz/core@7.1.3

## 12.3.0

### Minor Changes

- 6101959f7: Enhanced the router enrollment check to support non-fully connected warp routes using the `remoteRouters` property from the deployment config.
- 5db39f493: Fixes to support CosmosNative and warp apply with foreign deployments.
- 7500bd6fe: implemented cosmos protocol type and cosmos token adapter

### Patch Changes

- Updated dependencies [7500bd6fe]
  - @hyperlane-xyz/utils@12.3.0
  - @hyperlane-xyz/core@7.1.2
  - @hyperlane-xyz/cosmos-sdk@12.3.0

## 12.2.0

### Minor Changes

- c7934f711: Adds the isRevokeApprovalRequired method on the token adapters to check if the user should revoke any previously set allowances on the token to transfer to avoid approvals failing like in the case of USDT
- ecbacbdf2: Add EvmHypRebaseCollateralAdapter and EvmHypSyntheticRebaseAdapter

### Patch Changes

- @hyperlane-xyz/utils@12.2.0
- @hyperlane-xyz/core@7.1.1

## 12.1.0

### Minor Changes

- acbf5936a: New check: HyperlaneRouterChecker now compares the list of domains
  the Router is enrolled with against the warp route expectations.
  It will raise a violation for missing remote domains.
  `check-deploy` and `check-warp-deploy` scripts use this new check.
- c757b6a18: Include entire RPC array for chainMetadataToViemChain
- a646f9ca1: Added ZKSync specific deployment logic and artifact related utils
- 3b615c892: Adds the proxyAdmin.owner to the Checker ownerOverrides such that it checks proxyAdmin.owner instead of always using the top-level owner

### Patch Changes

- Updated dependencies [e6f6d61a0]
  - @hyperlane-xyz/core@7.1.0
  - @hyperlane-xyz/utils@12.1.0

## 12.0.0

### Major Changes

- 59a087ded: Remove unused FastTokenRouter

### Minor Changes

- 4d3738d14: Update Checker to only check collateralToken and collateralProxyAdmin if provided in ownerOverrides
- 07321f6f0: ZKSync Provider types with builders
- 337193305: Add new `public` field to RpcUrlSchema

### Patch Changes

- f7ca32315: fix: correct exported TypeScript types for synthetic tokens
- 59a087ded: Deploy new scaled warp route bytecode
- Updated dependencies [07321f6f0]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
  - @hyperlane-xyz/core@7.0.0
  - @hyperlane-xyz/utils@12.0.0

## 11.0.0

### Major Changes

- 3b060c3e1: Stub new CosmosModule ProtocolType.

### Minor Changes

- 888d180b6: Fixes a small bug when initializing a token adapter that caused the wrong adapter to be chosen when interacting with svm chains + add new warp ids for new soon wr deployments

### Patch Changes

- Updated dependencies [cd0424595]
- Updated dependencies [3b060c3e1]
  - @hyperlane-xyz/core@6.1.0
  - @hyperlane-xyz/utils@11.0.0

## 10.0.0

### Major Changes

- 4fd5623b8: Fixes a bug where `SealevelHypCollateralAdapter` initialization logic erroneously set the `isSpl2022` property to false.

  It updates the `Token.getHypAdapter` and `Token.getAdapter` methods to be async so that before creating an instance of the `SealevelHypCollateralAdapter` class, the collateral account info can be retrieved on chain to set the correct spl standard.

### Minor Changes

- 7dbf7e4fa: Deploy to cotitestnet, plumetestnet2, modetestnet.
- 28ca87293: Deploy to coti, deepbrainchain, nibiru, opbnb, reactive.

### Patch Changes

- Updated dependencies [b8d95fc95]
- Updated dependencies [fff9cbf57]
  - @hyperlane-xyz/utils@10.0.0
  - @hyperlane-xyz/core@6.0.4

## 9.2.1

### Patch Changes

- e3d09168e: Updated NON_ZERO_SENDER_ADDRESS to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 to fix reading on zksync chains
  - @hyperlane-xyz/utils@9.2.1
  - @hyperlane-xyz/core@6.0.3

## 9.2.0

### Minor Changes

- 7fe739d52: Update default ISMs with new validators for infinityvm, plume, fuse. Add gas buffer when deploying Interchain Accounts. Add gas buffer when transferring ownership of contracts in HyperlaneDeployer. Migrate safe signing from signTransactionHash -> signTypedData.
- 3e66e8f12: Utils for fetching Starknet chains
- 4f08670d8: Remove totalSupply from TokenMetadata and introduce initialSupply for synthetic warp routes

### Patch Changes

- 3852a9015: Fix WarpCore collateral check for lockboxes
  - @hyperlane-xyz/utils@9.2.0
  - @hyperlane-xyz/core@6.0.2

## 9.1.0

### Minor Changes

- 67d91e489: Constraint Max Mint Limit limit for super XERC20, separate check for limit and destination collateral and new lockbox token in TOKEN_COLLATERALIZED_STANDARDS
- cad82683f: Extracted ISM and Hook factory addresses into a reusable utility function to reduce repetition and improve maintainability.
- 351bf0010: Support populateClaimTx on SealevelIgpAdapter
- cad82683f: Improved warp route extension and configuration handling

### Patch Changes

- 97c773476: Skip non-Ethereum chains when deriving token metadata
  - @hyperlane-xyz/utils@9.1.0
  - @hyperlane-xyz/core@6.0.1

## 9.0.0

### Major Changes

- 4df37393f: Added minimal support for Starknet networks (for successful registry build)

### Minor Changes

- 0d8624d99: Make mailbox optional on warp deploy config
- b07e2f2ea: Estimate gas + add buffer on mailbox initialization, setting ISMs, setting IGP configs, setting routing hooks.

### Patch Changes

- 88970a78c: Deploy new scaled warp route bytecode
- Updated dependencies [88970a78c]
- Updated dependencies [88970a78c]
- Updated dependencies [4df37393f]
- Updated dependencies [88970a78c]
  - @hyperlane-xyz/core@6.0.0
  - @hyperlane-xyz/utils@9.0.0

## 8.9.0

### Minor Changes

- 05f89650b: Added utils for fetching extra lockboxes data from a xERC20 warp route
- d121c1cb8: Add XERC20 derivation in SDK/CLI Warp Reading
- 3518f8901: Implement HyperlaneCCIPDeployer and CCIPContractCache, for deploying and initializing CCIP ISMs/Hooks for supported pairs of CCIP chains.
- d6ddf5b9e: make warp:read and warp:check/warp:verify operations independent of signer requirements
- 766f50695: Change semantics of ism/hook config from undefined to 0x0 for reading/checking purposes
- e78060d73: Add CCIP boiler plate for existing ISM and Hook deployers.
- cb7c157f0: Support DefaultHook in the SDK.
- ede0cbc15: Don't derive testnet domains in IGP config derivation on mainnet
- 1955579cf: Expand warpDeployConfig for checking purposes
- 57137dad4: Add consts and utils for integrating with CCIP.
- 500249649: Enable usage of CCIP Hooks and ISMs in warp routes.
- 03266e2c2: add amount routing hook support in the sdk and cli
- cb93c13a4: Add EvmHypVSXERC20LockboxAdapter and EvmHypVSXERC20Adapter adapters
- 4147f91cb: Added AmountRoutingIsm support to the IsmReader and Factory

### Patch Changes

- 456407dc7: Adds checking to warp route collateral contracts
- Updated dependencies [1a0eba65b]
- Updated dependencies [05f89650b]
- Updated dependencies [9a010dfc1]
- Updated dependencies [1a0eba65b]
- Updated dependencies [f3c67a214]
- Updated dependencies [3518f8901]
- Updated dependencies [03266e2c2]
- Updated dependencies [27eadbfc3]
- Updated dependencies [4147f91cb]
  - @hyperlane-xyz/core@5.12.0
  - @hyperlane-xyz/utils@8.9.0

## 8.8.1

### Patch Changes

- @hyperlane-xyz/utils@8.8.1
- @hyperlane-xyz/core@5.11.6

## 8.8.0

### Minor Changes

- 719d022ec: Add availability field to Chain Metadata
- c61546cb7: Remove priority fee for sealevel non-solana chains

### Patch Changes

- @hyperlane-xyz/utils@8.8.0
- @hyperlane-xyz/core@5.11.5

## 8.7.0

### Minor Changes

- bd0b8861f: Deploy to hyperevm.
- 55db270e3: Deploy to chains bouncebit, arcadia, ronin, sophon, story, subtensor.
- b92eb1b57: Deploy to subtensortestnet.
- ede0cbc15: Don't derive testnet domains in IGP config derivation on mainnet
- 12e3c4da0: Enroll new validators for unichain, celo, base, mantle, worldchain, bouncebit, arcadia, ronin, sophon, story, subtensor, hyperevm.
- d6724c4c3: Fix an issue with HookModule that causes HookModule trigger triggering a new deployment due to unnormalized config despite configs being the same
- d93a38cab: Add MissingRouterViolation when config misses enrolled routers

### Patch Changes

- @hyperlane-xyz/utils@8.7.0
- @hyperlane-xyz/core@5.11.4

## 8.6.1

### Patch Changes

- @hyperlane-xyz/utils@8.6.1
- @hyperlane-xyz/core@5.11.3

## 8.6.0

### Minor Changes

- 407d82004: Enroll new validators for glue, matchain, unitzero, abstract, sonicsvm, injective, swell.
- 276d7ce4e: Deploy to berachain.
- 1e6ee0b9c: Add new validators for unichain and berachain.
- 77946bb13: Deploy to chronicleyellowstone testnet.

### Patch Changes

- ac984a17b: Fix contract address filtering to remove undefined factory addresses from the addresses map
- ba50e62fc: Added ESLint configuration and dependency to enforce Node.js module restrictions
- Updated dependencies [ba50e62fc]
  - @hyperlane-xyz/core@5.11.2
  - @hyperlane-xyz/utils@8.6.0

## 8.5.0

### Minor Changes

- 55b8ccdff: Improve usability of Token.FromChainMetadataNativeToken

### Patch Changes

- Updated dependencies [044665692]
  - @hyperlane-xyz/core@5.11.1
  - @hyperlane-xyz/utils@8.5.0

## 8.4.0

### Minor Changes

- f6b682cdb: Deploy to abstract, glue, matchain, unitzero.

### Patch Changes

- Updated dependencies [47ae33c6a]
  - @hyperlane-xyz/core@5.11.0
  - @hyperlane-xyz/utils@8.4.0

## 8.3.0

### Minor Changes

- 7546c0181: Deploy to trumpchain.
- 49856fbb9: Deploy to flametestnet, sonicblaze. Remove support for sonictestnet.

### Patch Changes

- Updated dependencies [db8c09011]
- Updated dependencies [11cf66c5e]
  - @hyperlane-xyz/core@5.10.0
  - @hyperlane-xyz/utils@8.3.0

## 8.2.0

### Minor Changes

- 69a684869: Don't try to build signers for non-EVM chains in MultiProtocolSignerManager

### Patch Changes

- @hyperlane-xyz/utils@8.2.0
- @hyperlane-xyz/core@5.9.2

## 8.1.0

### Minor Changes

- 9ab961a79: Deploy to new chains: artela, guru, hemi, nero, xpla.

### Patch Changes

- 79c61c891: Fix the return type of multisig and aggregation ISMs for zksync-stack chains.
- 9518dbc84: Enroll new validators for artela, guru, hemi, nero, soneium, torus, xpla.
  - @hyperlane-xyz/utils@8.1.0
  - @hyperlane-xyz/core@5.9.1

## 8.0.0

### Major Changes

- 26fbec8f6: Rename TokenConfig related types and utilities for clarity. E.g. `CollateralConfig` to `CollateralTokenConfig`.
  Export more config types and zod schemas

### Minor Changes

- fd20bb1e9: Add FeeHook and Swell to pz and ez eth config generator. Bump up Registry 6.6.0
- 9f6b8c514: Allow self-relaying of all messages if there are multiple in a given dispatch transaction.
- 82cebabe4: Call google storage API directly and remove @google-cloud/storage dependency from the SDK.
- 95cc9571e: Deploy to new chains: arthera, aurora, conflux, conwai, corn, evmos, form, ink, rivalz, soneium, sonic, telos.
- c690ca82f: Deploy to torus.
- e9911bb9d: Added new Sealevel tx submission and priority fee oracle params to agent config types

### Patch Changes

- 472b34670: Bump registry version to v6.3.0.
- 71aefa03e: export BaseMetadataBuilder
- 5942e9cff: Update default validator sets for alephzeroevmmainnet, appchain, lisk, lumiaprism, swell, treasure, vana, zklink.
- de1190656: Export TOKEN_STANDARD_TO_PROVIDER_TYPE, XERC20_STANDARDS, and MINT_LIMITED_STANDARDS maps
- Updated dependencies [79f8197f3]
- Updated dependencies [0eb8d52a4]
- Updated dependencies [8834a8c92]
  - @hyperlane-xyz/utils@8.0.0
  - @hyperlane-xyz/core@5.9.0

## 7.3.0

### Minor Changes

- 2054f4f5b: Require Sealevel native transfers to cover the rent of the recipient
- a96448fa6: Add logic into SDK to enable warp route unenrollment
- 170a0fc73: Add `createHookUpdateTxs()` to `WarpModule.update()` such that it 1) deploys a hook for a warp route _without_ an existing hook, or 2) update an existing hook.
- 9a09afcc7: Deploy to appchain, treasure, zklink.
- 24784af95: Introduce GcpValidator for retrieving announcements, checkpoints and metadata for a Validator posting to a GCP bucket. Uses GcpStorageWrapper for bucket operations.
- 3e8dd70ac: Update validators for boba, duckchain, unichain, vana, bsquared, superseed. Update oort's own validator. Update blockpi's viction validator. Adad luganodes/dsrv to flame validator set.
- aa1ea9a48: updates the warp deployment config schema to be closer to the ica routing schema
- f0b98fdef: Updated the derivation logic to enable ICA ISM metadata building from on chain data to enable self relaying of ICA messages
- ff9e8a72b: Added a getter to derive ATA payer accounts on Sealevel warp routes
- 97c1f80b7: Implement Sealevel IGP quoting
- 323f0f158: Add ICAs management in core apply command
- 61157097b: Deploy to swell & lumiaprism. Parallelise router enrollment in HyperlaneRouterDeployer.

### Patch Changes

- 665a7b8d8: Added decimal consistency checks to the Token checker
  - @hyperlane-xyz/utils@7.3.0
  - @hyperlane-xyz/core@5.8.3

## 7.2.0

### Minor Changes

- 81ab4332f: Remove ismFactoryAddresses from warpConfig
- 4b3537470: Changed the type of defaultMultisigConfigs, to track validator aliases in addition to their addresses.
- fa6d5f5c6: Add decodeIsmMetadata function

### Patch Changes

- Updated dependencies [fa6d5f5c6]
  - @hyperlane-xyz/utils@7.2.0
  - @hyperlane-xyz/core@5.8.2

## 7.1.0

### Minor Changes

- 6f2d50fbd: Updated Fraxtal set to include Superlane validators, updated Flow set
- 1159e0f4b: Enroll new validators for alephzeroevmmainnet, chilizmainnet, flowmainnet, immutablezkevmmainnet, metal, polynomialfi, rarichain, rootstockmainnet, superpositionmainnet, flame, prom, inevm.
- ff2b4e2fb: Added helpers to Token and token adapters to get bridged supply of tokens"
- 0e285a443: Add a validateZodResult util function
- 5db46bd31: Implements persistent relayer for use in CLI
- 0cd65c571: Add chainMetadataToCosmosChain function

### Patch Changes

- Updated dependencies [0e285a443]
  - @hyperlane-xyz/utils@7.1.0
  - @hyperlane-xyz/core@5.8.1

## 7.0.0

### Major Changes

- f48cf8766: Upgrade Viem to 2.2 and Solana Web3 to 1.9
  Rename `chainMetadataToWagmiChain` to `chainMetadataToViemChain`
- 5f41b1134: Remove getCoingeckoTokenPrices (use CoinGeckoTokenPriceGetter instead)

### Minor Changes

- bbb970a44: Redeploy to alephzeroevmmainnet, chilizmainnet, flowmainnet, immutablezkevmmainnet, metal, polynomialfi, rarichain, rootstockmainnet, superpositionmainnet. Deploy to flame, prom.
- fa424826c: Add support for updating the mailbox proxy admin owner
- 40d59a2f4: Deploy to abstracttestnet and treasuretopaz
- 0264f709e: Deploy to alephzeroevmtestnet, update deployment for arcadiatestnet2.
- 836060240: Add storage based multisig ISM types
- f24835438: Added coinGeckoId as an optional property of the TokenConfigSchema

### Patch Changes

- ba0122279: feat: use message context in hook reader IGP derivation
- Updated dependencies [f48cf8766]
- Updated dependencies [836060240]
- Updated dependencies [e6f9d5c4f]
  - @hyperlane-xyz/utils@7.0.0
  - @hyperlane-xyz/core@5.8.0

## 6.0.0

### Major Changes

- e3b97c455: Detangle assumption that chainId == domainId for EVM chains. Domain IDs and Chain Names are still unique, but chainId is no longer guaranteed to be a unique identifier. Domain ID is no longer an optional field and is now required for all chain metadata.

### Minor Changes

- 7b3b07900: Support using apiKey for CoinGeckoTokenPriceGetter
- 30d92c319: Add `collateralChainName` to Warp Reader. Partial refactor of fetchTokenConfig().

### Patch Changes

- Updated dependencies [e3b97c455]
  - @hyperlane-xyz/utils@6.0.0
  - @hyperlane-xyz/core@5.7.1

## 5.7.0

### Minor Changes

- 469f2f340: Checking for sufficient fees in `AbstractMessageIdAuthHook` and refund surplus
- d9505ab58: Deploy to apechain, arbitrumnova, b3, fantom, gravity, harmony, kaia, morph, orderly, snaxchain, zeronetwork, zksync. Update default metadata in `HyperlaneCore` to `0x00001` to ensure empty metadata does not break on zksync.
- 7e9e248be: Add feat to allow updates to destination gas using warp apply
- 4c0605dca: Add optional proxy admin reuse in warp route deployments and admin proxy ownership transfer in warp apply
- db9196837: Update default validator sets. Throw in `InterchainAccount.getOrDeployAccount` if the origin router is the zero address.
- db5875cc2: Add `hyperlane warp verify` to allow post-deployment verification.
- 956ff752a: Introduce utils that can be reused by the CLI and Infra for fetching token prices from Coingecko and gas prices from EVM/Cosmos chains.

### Patch Changes

- 5dabdf388: Optimize HyperlaneRelayer routing config derivation
- e104cf6aa: Dedupe internals of hook and ISM module deploy code
- 56328e6e1: Fix ICA ISM self relay
- Updated dependencies [469f2f340]
- Updated dependencies [e104cf6aa]
- Updated dependencies [04108155d]
- Updated dependencies [f26453ee5]
- Updated dependencies [0640f837c]
- Updated dependencies [a82b4b4cb]
- Updated dependencies [39a9b2038]
  - @hyperlane-xyz/core@5.7.0
  - @hyperlane-xyz/utils@5.7.0

## 5.6.2

### Patch Changes

- 5fd4267e7: Supported non-32 byte non-EVM recipients when sending warps from Sealevel
- Updated dependencies [5fd4267e7]
- Updated dependencies [a36fc5fb2]
- Updated dependencies [a42616ff3]
  - @hyperlane-xyz/utils@5.6.2
  - @hyperlane-xyz/core@5.6.1

## 5.6.1

### Patch Changes

- Updated dependencies [8cc0d9a4a]
- Updated dependencies [c55257cf5]
- Updated dependencies [8cc0d9a4a]
  - @hyperlane-xyz/core@5.6.0
  - @hyperlane-xyz/utils@5.6.1

## 5.6.0

### Minor Changes

- 46044a2e9: Deploy to odysseytestnet
- 02a5b92ba: Enroll new validators. Add tx overrides when deploying ICA accounts. Core checker now surfaces owner violations for defaultHook and requiredHook. App checker temporarily ignores bytecode mismatch violations.
- 29341950e: Adds new `core check` command to compare local configuration and on chain deployments. Adds memoization to the EvmHookReader to avoid repeating configuration derivation
- 8001bbbd6: Add override to some transactions to fix warp apply
- 32d0a67c2: Adds the warp check command to compare warp routes config files with on chain warp route deployments
- b1ff48bd1: Add rebasing yield route support into CLI/SDK
- d41aa6928: Add `EthJsonRpcBlockParameterTag` enum for validating reorgPeriod
- c3e9268f1: Add support for an arbitrary string in `reorgPeriod`, which is used as a block tag to get the finalized block.
- 7d7bcc1a3: Add deployments for mainnets: flow, metall2, polynomial

### Patch Changes

- 7f3e0669d: Fix filtering non-evm addresses in appFromAddressesMapHelper
- 2317eca3c: Set transaction overrides and add 10% gas limit buffer when sending message through HyperlaneCore.
- Updated dependencies [f1712deb7]
- Updated dependencies [29341950e]
- Updated dependencies [c9085afd9]
- Updated dependencies [ec6b874b1]
- Updated dependencies [72c23c0d6]
  - @hyperlane-xyz/utils@5.6.0
  - @hyperlane-xyz/core@5.5.0

## 5.5.0

### Minor Changes

- 2afc484a2: Break out BlockExplorerSchema and export separately
  Migrate RPC + Explorer health tests back to SDK from registry
- 3254472e0: Add deployments for chains: immutablezkevm, rari, rootstock, alephzeroevm, chiliz, lumia, and superposition
- 6176c9861: Add opstack, polygoncdk, polkadotsubstrate and zksync to ChainTechnicalStack enum

### Patch Changes

- fcfe91113: Reuse SDK transaction typings in tx submitters
- Updated dependencies [92c86cca6]
- Updated dependencies [2afc484a2]
  - @hyperlane-xyz/core@5.4.1
  - @hyperlane-xyz/utils@5.5.0

## 5.4.0

### Minor Changes

- 4415ac224: Add Gnosis safe transaction builder to warp apply

### Patch Changes

- Updated dependencies [bb75eba74]
- Updated dependencies [4415ac224]
- Updated dependencies [c5c217f8e]
  - @hyperlane-xyz/core@5.4.0
  - @hyperlane-xyz/utils@5.4.0

## 5.3.0

### Patch Changes

- eb47aaee8: Use collateral account for sealevel native warp route balance
- 50319d8ba: Make HyperlaneDeployer.chainTimeoutMs public.
  Remove HyperlaneDeployer.startingBlockNumbers as it's not used by any deployer.
  Update HyperlaneDeployer.deploy for better logging and error handling.
- 8de531fa4: fix: warn on submodule metadata builder failures
- fd536a79a: Include priority fee instruction with SVM warp transfers
- Updated dependencies [746eeb9d9]
- Updated dependencies [50319d8ba]
  - @hyperlane-xyz/utils@5.3.0
  - @hyperlane-xyz/core@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [eb5afcf3e]
  - @hyperlane-xyz/core@5.2.1
  - @hyperlane-xyz/utils@5.2.1

## 5.2.0

### Minor Changes

- a19e882fd: Improve Router Checker/Governor tooling to support enrolling multiple routers for missing domains
- 203084df2: Added sdk support for Stake weighted ISM
- 74a592e58: Adds OwnerCollateral to token mapping which will output the correct standard to the warp deploy artifact.
- 739af9a34: Support providing multiple chains for checking in HyperlaneAppChecker
- 44588c31d: Enroll new validators for cyber degenchain kroma lisk lukso merlin metis mint proofofplay real sanko tangle xai taiko
- 291c5fe36: Use addBufferToGasLimit from @hyperlane-xyz/utils
- 69f17d99a: Fix to correctly infer the default set of multisend addresses for a given chain, and update to latest safe-deployments patch release
- 9563a8beb: Sorted cwNative funds by denom in transfer tx
- 73c232b3a: Deploy to oortmainnet
- 445b6222c: ArbL2ToL1Ism handles value via the executeTransaction branch
- d6de34ad5: Sort values in EvmModuleDeployer.deployStaticAddressSet
- 2e6176f67: Deploy to everclear mainnet
- f2783c03b: Add ChainSubmissionStrategySchema
- 3c07ded5b: Add Safe submit functionality to warp apply

### Patch Changes

- 518a1bef9: add 10% gas bump to initialize call in EvmModuleDeployer
- 2bd540e0f: Estimate and add 10% gas bump for ICA initialization and enrollment
- 3ad5918da: Support DefaultFallbackRoutingIsm in metadata builder
- 2ffb78f5c: Improved check for mailbox initialization
- 815542dd7: Fix arg validation for Sealevel HypNative adapters
  Allow extra properties in ChainMetadata objects
- Updated dependencies [d6de34ad5]
- Updated dependencies [203084df2]
- Updated dependencies [291c5fe36]
- Updated dependencies [445b6222c]
  - @hyperlane-xyz/utils@5.2.0
  - @hyperlane-xyz/core@5.2.0

## 5.1.0

### Minor Changes

- 013f19c64: Add ether's error reasoning handling to SmartProvider to show clearer error messages
- 013f19c64: Support proxiedFactories in HypERC20App and extend HypERC20Checker with ProxiedRouterChecker
- 013f19c64: Deploy to arbitrumsepolia, basesepolia, ecotestnet, optimismsepolia, polygonamoy
- 013f19c64: Deploy to zircuit
- 013f19c64: Update cosmos zod schema and enroll new validators for cheesechain, xlayer, zircuit, worldchain.
- 013f19c64: Added SDK support for ArbL2ToL1Hook/ISM for selfrelay
- 013f19c64: Support proxyAdmin checks for non AW owned warp router contracts
- 013f19c64: Add stride validators to default multisig ism
- 013f19c64: Adds CollateralFiat to token mapping which will output the correct standard to the warp deploy artifact.
- 013f19c64: Deploy to solana + eclipse
- 013f19c64: Added yield route with yield going to message recipient.
- 19f7d4fd9: Support passing foreignDeployments to HypERC20App constructor

### Patch Changes

- 013f19c64: feat: Add long-running CLI relayer
- 013f19c64: Support xERC20Lockbox in checkToken
- 013f19c64: Update ProxyAdminViolation interface to include proxyAdmin and proxy contract fields
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
  - @hyperlane-xyz/core@5.1.0
  - @hyperlane-xyz/utils@5.1.0

## 5.0.0

### Major Changes

- 488f949ef: Upgrade CosmJS libs to 0.32.4

### Minor Changes

- 2c0ae3cf3: Deploy to connextsepolia + superpositiontestnet
- 0dedbf5a0: Deploy to endurance, fusemainnet, zoramainnet
- 388d25517: Added HyperlaneRelayer for relaying messages from the CLI
- 4907b510c: Add logic to parse SmartProvider errors to handle ethers and smart provider errors
- c7f5a35e8: Add hyperlane core apply with update default Ism
- f83b492de: - Enable updating of hooks through the `EvmHookModule`, including IGP and gas oracles.
  - Drive-by fixes to ISM module and tests.
- 79740755b: Add enroll remote router to WarpModule
- 8533f9e66: Adds transferOwnership to warp update to allow ownership to be transferred if the onchain owner differ
- ed65556aa: Improve WarpCore validation error message for IGP fee checks
- cfb890dc6: Remove outdated logos in SDK (now in registry)
- 708999433: Adds hyperlane warp apply
- 5529d98d0: Add hyperlane core apply with update ownership
- 62d71fad3: Add hyperlane warp update to extend a warp config
- 49986aa92: Add collateralAddressOrDenom for collateralVault
- 8e942d3c6: Deploy to cheesechain, worldchain, xlayer

### Patch Changes

- 69a39da1c: Fix issue with cosmos tx estimation
- 7265a4087: Add rpcUrl, chainId, and method(params) to smart provider logging.
- 0a40dcb8b: Update cosmos chain schema
- ab827a3fa: Removes inaccurate contract verification check, resulting in proxy contracts not being marked as proxies during contract verification.
- dfa908796: add error message for all calls to assert util
- ed63e04c4: Creates HyperlaneReader to re-use dyn provider log level & silences provider logs in deriveIsmConfig like deriveHookConfig.
- 5aa24611b: Add 'isInitialized' check before initializing implementation contract (for contracts that disableInitializers in constructors).
- 7fdd3958d: Adds logic to prune and minify build artifacts to address 'entity size too large' error thrown from explorers. Note that the only identified instance of this issue is on BSC mainnet.
- fef629673: ContractVerifier now adjusts timeouts based on explorer family, which helps with many rate-limiting related contract verification issues. In addition, the ContractVerifier verify logic has been greatly simplified to allowing for a predictable callstack + easy debugging.
- be4617b18: Handle subdirectories for the folder in S3Validator class
- Updated dependencies [388d25517]
- Updated dependencies [488f949ef]
- Updated dependencies [dfa908796]
- Updated dependencies [90598ad44]
- Updated dependencies [1474865ae]
  - @hyperlane-xyz/utils@5.0.0
  - @hyperlane-xyz/core@5.0.0

## 4.1.0

### Minor Changes

- 36e75af4e: Add optional deployer field to ChainMetadata schema
- d31677224: Deploy to bob, mantle, taiko
- 4cc9327e5: Update warp deploy to handle xerc20, initializerArgs to be the signer, update deploy gas constants
- 1687fca93: Add EvmWarpModule with update() for ISM

### Patch Changes

- @hyperlane-xyz/core@4.1.0
- @hyperlane-xyz/utils@4.1.0

## 4.0.0

### Minor Changes

- b05ae38ac: Gracefully handle RPC failures during warp send & fix deriving hook error that prevents warp and core test messages on the cli.
- 9304fe241: Use metadata builders in message relaying
- bdcbe1d16: Add EvmWarpModule with create()
- e38d31685: Add logic to set smart provider log level to disable provider logs during Warp TokenType derive
- e0f226806: - Enables creation of new Hooks through the `EvmHookModule`.
  - Introduces an `EvmModuleDeployer` to perform the barebones tasks of deploying contracts/proxies.
- 6db9fa9ad: Implement hyperlane warp deploy

### Patch Changes

- 6b63c5d82: Adds deployment support for IsmConfig within a WarpRouteConfig
- Updated dependencies [44cc9bf6b]
  - @hyperlane-xyz/core@4.0.0
  - @hyperlane-xyz/utils@4.0.0

## 3.16.0

### Minor Changes

- 5cc64eb09: Add validator addresses for linea, fraxtal, sei.
  Estimate gas and add 10% buffer inside HyperlaneIsmFactory as well.

### Patch Changes

- f9bbdde76: Fix initial total supply of synthetic token deployments to 0
  - @hyperlane-xyz/core@3.16.0
  - @hyperlane-xyz/utils@3.16.0

## 3.15.1

### Patch Changes

- acaa22cd9: Do not consider xERC20 a collateral standard to fix fungibility checking logic while maintaining mint limit checking
- 921e449b4: Support priorityFee fetching from RPC and some better logging
- Updated dependencies [6620fe636]
  - @hyperlane-xyz/core@3.15.1
  - @hyperlane-xyz/utils@3.15.1

## 3.15.0

### Minor Changes

- 51bfff683: Mint/burn limit checking for xERC20 bridging
  Corrects CLI output for HypXERC20 and HypXERC20Lockbox deployments

### Patch Changes

- Updated dependencies [51bfff683]
  - @hyperlane-xyz/core@3.15.0
  - @hyperlane-xyz/utils@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [a8a68f6f6]
  - @hyperlane-xyz/core@3.14.0
  - @hyperlane-xyz/utils@3.14.0

## 3.13.0

### Minor Changes

- 39ea7cdef: Implement multi collateral warp routes
- babe816f8: Support xERC20 and xERC20 Lockbox in SDK and CLI
- 0cf692e73: Implement metadata builder fetching from message

### Patch Changes

- Updated dependencies [babe816f8]
- Updated dependencies [b440d98be]
- Updated dependencies [0cf692e73]
  - @hyperlane-xyz/core@3.13.0
  - @hyperlane-xyz/utils@3.13.0

## 3.12.0

### Minor Changes

- 69de68a66: Implement aggregation and multisig ISM metadata encoding

### Patch Changes

- eba393680: Exports submitter and transformer props types.
- Updated dependencies [69de68a66]
  - @hyperlane-xyz/utils@3.12.0
  - @hyperlane-xyz/core@3.12.0

## 3.11.1

### Patch Changes

- c900da187: Workaround TS bug in Safe protocol-lib
  - @hyperlane-xyz/core@3.11.1
  - @hyperlane-xyz/utils@3.11.1

## 3.11.0

### Minor Changes

- 811ecfbba: Add EvmCoreReader, minor updates.
- f8b6ea467: Update the warp-route-deployment.yaml to a more sensible schema. This schema sets us up to allow multi-chain collateral deployments. Removes intermediary config objects by using zod instead.
- d37cbab72: Adds modular transaction submission support for SDK clients, e.g. CLI.
- b6fdf2f7f: Implement XERC20 and FiatToken collateral warp routes
- 2db77f177: Added RPC `concurrency` property to `ChainMetadata`.
  Added `CrudModule` abstraction and related types.
  Removed `Fuel` ProtocolType.
- 3a08e31b6: Add EvmERC20WarpRouterReader to derive WarpConfig from TokenRouter address
- 917266dce: Add --self-relay to CLI commands
- aab63d466: Adding ICA for governance
- b63714ede: Convert all public hyperlane npm packages from CJS to pure ESM
- 3528b281e: Remove consts such as chainMetadata from SDK
- 450e8e0d5: Migrate fork util from CLI to SDK. Anvil IP & Port are now optionally passed into fork util by client.
- af2634207: Moved Hook/ISM config stringify into a general object stringify utility.

### Patch Changes

- a86a8296b: Removes Gnosis safe util from infra in favor of SDK
- 2e439423e: Allow gasLimit overrides in the SDK/CLI for deploy txs
- Updated dependencies [b6fdf2f7f]
- Updated dependencies [b63714ede]
- Updated dependencies [2b3f75836]
- Updated dependencies [af2634207]
  - @hyperlane-xyz/core@3.11.0
  - @hyperlane-xyz/utils@3.11.0

## 3.10.0

### Minor Changes

- 96485144a: SDK support for ICA deployment and operation.
- 38358ecec: Deprecate Polygon Mumbai testnet (soon to be replaced by Polygon Amoy testnet)
- ed0d4188c: Fixed an issue where warp route verification would fail at deploy time due to a mismatch between the SDK's intermediary contract representation and actual contract name.
  Enabled the ContractVerifier to pick up explorer API keys from the configured chain metadata. This allows users to provide their own explorer API keys in custom `chains.yaml` files.
- 4e7a43be6: Replace Debug logger with Pino

### Patch Changes

- Updated dependencies [96485144a]
- Updated dependencies [38358ecec]
- Updated dependencies [4e7a43be6]
  - @hyperlane-xyz/utils@3.10.0
  - @hyperlane-xyz/core@3.10.0

## 3.9.0

### Minor Changes

- 11f257ebc: Add Yield Routes to CLI

### Patch Changes

- @hyperlane-xyz/core@3.9.0
- @hyperlane-xyz/utils@3.9.0

## 3.8.2

### Patch Changes

- @hyperlane-xyz/core@3.8.2
- @hyperlane-xyz/utils@3.8.2

## 3.8.1

### Patch Changes

- 5daaae274: Prevent warp transfers to zero-ish addresses
- Updated dependencies [5daaae274]
  - @hyperlane-xyz/utils@3.8.1
  - @hyperlane-xyz/core@3.8.1

## 3.8.0

### Minor Changes

- 9681df08d: **New Feature**: Add transaction fee estimators to the SDK
  **Breaking change**: Token Adapter `quoteGasPayment` method renamed to `quoteTransferRemoteGas` for clarity.
- 9681df08d: Remove support for goerli networks (including optimismgoerli, arbitrumgoerli, lineagoerli and polygonzkevmtestnet)
- 9681df08d: Enabled verification of contracts as part of the deployment flow.
  - Solidity build artifact is now included as part of the `@hyperlane-xyz/core` package.
  - Updated the `HyperlaneDeployer` to perform contract verification immediately after deploying a contract. A default verifier is instantiated using the core build artifact.
  - Updated the `HyperlaneIsmFactory` to re-use the `HyperlaneDeployer` for deployment where possible.
  - Minor logging improvements throughout deployers.

- 9681df08d: Add `WarpCore`, `Token`, and `TokenAmount` classes for interacting with Warp Route instances.

  _Breaking change_: The params to the `IHypTokenAdapter` `populateTransferRemoteTx` method have changed. `txValue` has been replaced with `interchainGas`.

### Patch Changes

- 9681df08d: Support configuring non-EVM IGP destinations
- 9681df08d: Removed basegoerli and moonbasealpha testnets
- 9681df08d: Add logos for plume to SDK
- 9681df08d: TestRecipient as part of core deployer
- 9681df08d: Update viction validator set
- 9681df08d: Minor fixes for SDK cosmos logos
- 9681df08d: Implement message id extraction for CosmWasmCoreAdapter
- 9681df08d: Patch transfer ownership in hook deployer
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
  - @hyperlane-xyz/core@3.8.0
  - @hyperlane-xyz/utils@3.8.0

## 3.7.0

### Minor Changes

- 54aeb6420: Added warp route artifacts type adopting registry schema

### Patch Changes

- 6f464eaed: Add logos for injective and nautilus
- 87151c62b: Bumped injective reorg period
- ab17af5f7: Updating HyperlaneIgpDeployer to configure storage gas oracles as part of deployment
- 7b40232af: Remove unhealthy zkevm rpc
  - @hyperlane-xyz/core@3.7.0
  - @hyperlane-xyz/utils@3.7.0

## 3.6.2

### Patch Changes

- @hyperlane-xyz/core@3.6.2
- @hyperlane-xyz/utils@3.6.2

## 3.6.1

### Patch Changes

- ae4476ad0: Bumped mantapacific reorgPeriod to 1, a reorg period in chain metadata is now required by infra.
- f3b7ddb69: Add optional grpcUrl field to ChainMetadata
- e4e4f93fc: Support pausable ISM in deployer and checker
- Updated dependencies [3c298d064]
- Updated dependencies [df24eec8b]
- Updated dependencies [78e50e7da]
- Updated dependencies [e4e4f93fc]
  - @hyperlane-xyz/utils@3.6.1
  - @hyperlane-xyz/core@3.6.1

## 3.6.0

### Minor Changes

- 0488ef31d: Add dsrv, staked and zeeprime as validators
- 8d8ba3f7a: HyperlaneIsmFactory is now wary of (try)getDomainId or (try)getChainName calls which may fail and handles them appropriately.

### Patch Changes

- 67a6d971e: Added `shouldRecover` flag to deployContractFromFactory so that the `TestRecipientDeployer` can deploy new contracts if it's not the owner of the prior deployments (We were recovering the SDK artifacts which meant the deployer won't be able to set the ISM as they needed)
- 612d4163a: Add mailbox version const to SDK
  - @hyperlane-xyz/core@3.6.0
  - @hyperlane-xyz/utils@3.6.0

## 3.5.1

### Patch Changes

- a04454d6d: Use getBalance instead of queryContractSmart for CwTokenAdapter
  - @hyperlane-xyz/core@3.5.1
  - @hyperlane-xyz/utils@3.5.1

## 3.5.0

### Minor Changes

- 655b6a0cd: Redeploy Routing ISM Factories

### Patch Changes

- 08ba0d32b: Remove dead arbitrum goerli explorer link"
- f7d285e3a: Adds Test Recipient addresses to the SDK artifacts
  - @hyperlane-xyz/core@3.5.0
  - @hyperlane-xyz/utils@3.5.0

## 3.4.0

### Minor Changes

- b832e57ae: Replace Fallback and Retry Providers with new SmartProvider with more effective fallback/retry logic

### Patch Changes

- 7919417ec: Granular control of updating predeployed routingIsms based on routing config mismatch
  - Add support for routingIsmDelta which filters out the incompatibility between the onchain deployed config and the desired config.
  - Based on the above, you either update the deployed Ism with new routes, delete old routes, change owners, etc.
  - `moduleMatchesConfig` uses the same
- fd4fc1898: - Upgrade Viem to 1.20.0
  - Add optional restUrls field to ChainMetadata
  - Add deepCopy util function
  - Add support for cosmos factory token addresses
- e06fe0b32: Supporting DefaultFallbackRoutingIsm through non-factory deployments
- 79c96d718: Remove healthy RPC URLs and remove NeutronTestnet
- Updated dependencies [fd4fc1898]
- Updated dependencies [e06fe0b32]
  - @hyperlane-xyz/utils@3.4.0
  - @hyperlane-xyz/core@3.4.0

## 3.3.0

### Patch Changes

- 7e620c9df: Allow CLI to accept hook as a config
- 350175581: Rename StaticProtocolFee hook to ProtocolFee for clarity
- 9f2c7ce7c: Removing agentStartBlocks and using mailbox.deployedBlock() instead
- Updated dependencies [350175581]
  - @hyperlane-xyz/core@3.3.0
  - @hyperlane-xyz/utils@3.3.0

## 3.2.0

### Minor Changes

- df693708b: Add support for all ISM types in CLI interactive config creation

### Patch Changes

- Updated dependencies [df34198d4]
  - @hyperlane-xyz/core@3.2.0
  - @hyperlane-xyz/utils@3.2.0

## 3.1.10

### Patch Changes

- Updated dependencies [c9e0aedae]
  - @hyperlane-xyz/core@3.1.10
  - @hyperlane-xyz/utils@3.1.10
