# EVM Artifact API Migration Plan

Date: 2026-09-28

Status: active compatibility-first migration.

## Implementation tracking

The migration is maintained as a stack. Each branch is based on the preceding
branch unless noted otherwise.

| Order | Branch                                   | Scope                                                                                                                                  | Last implementation commit | Status               |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------- |
| 1     | `xeno/artifact-factories-refactor`       | Partial artifact-manager support and standardized hook, ISM, and warp factory dispatch                                                 | `d84bc1bafd`               | Pushed; no PR opened |
| 2     | `xeno/provider-sdk-artifact-type-parity` | Provider SDK artifact vocabulary parity and SDK/AltVM consumer adoption                                                                | `3e6b6d6366`               | Pushed; no PR opened |
| 3     | `xeno/provider-context-full-addresses`   | Typed chain address sets, complete provider contexts, partial composition contexts, and address propagation through protocol factories | `56642a0b86`               | Pushed; no PR opened |

For every future phase:

1. Create the branch from the latest branch in this table.
2. Add a row as soon as the branch is created.
3. Keep its scope, last implementation commit, and status current after code
   commits, pushes, PR creation, rebases, and merges.
4. Record deliberate base changes so the stack order remains reproducible.

## Goal

Put existing EVM behavior behind the provider-sdk Artifact API before moving its
implementation into a dedicated EVM protocol package.

The first migration is an interface/facade migration, not a rewrite. Existing EVM
readers, modules, transaction ordering, deployment behavior, and tests remain the
source of truth until parity is proven.

## Initial boundary

- `provider-sdk` defines the common protocol and Artifact API interfaces, but its
  hook, ISM, and token catalogs omit many types already supported by EVM.
- `deploy-sdk` consumes the protocol registry but also owns protocol package loading
  in `typescript/deploy-sdk/src/protocol.ts`.
- CLI loads only non-EVM providers and branches to existing EVM classes directly.
- Artifact factories receive chain metadata plus small, artifact-specific address
  fragments such as `{ mailbox }`.
- Existing EVM classes depend on `MultiProvider`, registry addresses, and mature
  SDK configuration types.
- Submission is split between provider-sdk's JSON-RPC/impersonated/file submitters
  and SDK's JSON-RPC, impersonated, Safe, Safe Builder, ICA, and timelock stack.

## Adversarial review conclusions

Three independent reviews challenged the plan's mergeability. Accepted findings:

- `AnnotatedTx` appears across 74 TypeScript files. The final shape change is one
  coordinated mechanical cutover, prepared by protocol-local validators in earlier
  PRs; it must not be mixed with EVM facade work.
- Widening artifact unions breaks exhaustive protocol dispatch tables unless those
  tables first become explicit partial-support maps with clear unsupported errors.
- `loadProtocolProviders` has SDK and infra consumers, so CLI ownership requires a
  compatibility period rather than immediate deletion from deploy-sdk.
- Ethereum-only registration would preserve Tron special cases; both EVM-like
  protocols need the facade path.
- Full registry addresses do not replace `MultiProvider`, verifier services, or
  operation-specific options.
- Generic and EVM core deployment order differs, so core deployment needs a
  high-level compatibility facade before any orchestration rewrite.
- EVM package extraction requires a deliberate dependency-direction flip after the
  new package no longer imports SDK.
- EVM write cutovers cannot precede submitter parity: update/apply flows must retain
  direct, file, Safe, ICA, timelock, fee-submitter, retry, and payload behavior.

## Migration sequence

### 1. Define the complete artifact vocabulary in provider-sdk

Add every currently supported EVM hook, ISM, and token discriminator and config
shape to provider-sdk, even when no AltVM implementation supports it.

This does not imply universal runtime support. That is already true today: some
protocol providers support only subsets of the artifact types defined in
provider-sdk. Unsupported managers keep their current explicit rejection behavior.

Work:

- Expand `provider-sdk/src/hook.ts` from the current four types to the full SDK
  hook catalog.
- Expand `provider-sdk/src/ism.ts` from the current subset to the full SDK ISM
  catalog.
- Expand `provider-sdk/src/warp.ts` to all current token types.
- Define lossless mapping requirements; implement SDK ↔ provider conversions in
  the SDK/EVM facade layer.
- Preserve existing SDK exports as aliases during migration.
- Add exhaustive conversion and serialization tests.

Do not add a capability-registry redesign as a prerequisite. Type recognition and
protocol implementation support remain separate concerns.

### 2. Pass the full per-chain address set into provider construction

Keep chain metadata as the first factory argument. Extend the existing second
configuration/context argument with chain addresses where they affect behavior:

```ts
interface ProtocolChainAddresses {
  mailbox: string;
  validatorAnnounce: string;
  interchainSecurityModule: string;
  merkleTreeHook: string;
  [address: string]: string | undefined;
}

interface ProtocolProviderContext {
  addresses?: ProtocolChainAddresses;
}

interface ProtocolArtifactManagerContext {
  addresses?: Partial<ProtocolChainAddresses>;
}
```

`ProtocolChainAddresses` is a provider-sdk-owned structural type compatible with
the registry's per-chain address set. Provider-sdk does not gain a registry package
dependency.

The resulting factory shape is:

```ts
createSigner(chainMetadata, signerConfig);
createSubmitter(chainMetadata, submitterConfigWithProviderContext);
createIsmArtifactManager(chainMetadata);
createHookArtifactManager(chainMetadata, artifactManagerContext);
createWarpArtifactManager(chainMetadata, artifactManagerContext);
createMailboxArtifactManager(chainMetadata);
createValidatorAnnounceArtifactManager(chainMetadata);
createFeeArtifactManager(chainMetadata, feeContextWithArtifactManagerContext);
```

Rules:

- CLI obtains the complete address set from `registry.getChainAddresses(chain)`.
- Existing chains receive all known addresses, not a hand-picked subset.
- Complete provider contexts are runtime-validated before registry address records
  are narrowed to `ProtocolChainAddresses`.
- Artifact composition uses a separate partial context because core and warp flows
  may only know the mailbox while nested artifacts are being created.
- Signer configuration remains limited to signer identity and credentials.
- Protocol implementations validate protocol-specific fields before narrowing
  them; provider-sdk does not claim that those fields exist.

This supplies EVM facades with mailbox, proxy factories, ProxyAdmin, ICA, validator
announce, and other known dependencies without repeatedly changing common factory
signatures.

The address set is necessary but not sufficient for EVM parity. The SDK-hosted EVM
provider may additionally capture `MultiProvider`, verifier/API-key services, and
operation-specific read options such as hook fee tokens. Those do not belong in the
provider-sdk address type.

### 3. Make transactions self-describing

Replace the current permissive raw transaction alias with the canonical shape:

```ts
interface Tx<TTransaction = unknown> {
  chainName: string;
  sender: string;
  transaction: TTransaction;
}

type AnnotatedTx<TTransaction = unknown> = Annotated<Tx<TTransaction>>;
```

`sender` means the logical account expected to authorize execution. It may be a
direct signer, Safe, ICA, or other governance account; it is not necessarily the
fee payer or final executor.

Rules:

- provider-sdk sees `Tx<unknown>` at erased/external boundaries
- each protocol owns `assertXTx` and validates the inner transaction before
  printable conversion, signing, batching, or submission
- signers assert that `chainName` matches their configured chain
- direct signers assert that `sender` matches the connected account
- Safe/ICA/file submitters validate against their configured logical authority
- printable/file conversion replaces only the inner `transaction`, preserving
  `chainName`, `sender`, and `annotation`
- batches validate every item and cannot silently mix chains or senders

There is no separate envelope abstraction and no central protocol transaction
union. The final type change is atomic across callers; protocol validators and
tests land first to keep that cutover mechanical.

### 4. Adapt existing EVM classes with facades and conversions

Implement the EVM provider and signer adapters in SDK first, then compose
`EvmProtocolProvider` once its submitter facades are ready. It satisfies
provider-sdk interfaces while delegating to existing EVM code.

The approach should mirror `MultiProviderAdapter` /
`MultiProtocolProvider.fromMultiProvider`: translate at the boundary and retain the
existing implementation behind it.

Required facade layers:

1. Provider and signer adapters between ethers/`MultiProvider` and provider-sdk
   interfaces.
2. Raw artifact-manager facades around existing EVM readers and modules.
3. SDK config ↔ provider artifact conversions.
4. Receipt/transaction conversions without changing ordering, authority, or
   execution semantics.

Artifact order:

1. hooks and ISMs
2. tokens
3. core/mailbox and remaining core artifacts

Within each artifact family:

1. add conversions
2. wrap reads
3. compare facade reads with legacy reads
4. wrap planning/apply/deploy
5. compare transactions and final state
6. switch CLI dispatch only after parity

The facade may be inelegant. Its purpose is to make both paths equivalent before
code ownership changes. Core deployment initially needs a high-level facade around
`EvmCoreModule`: the generic writer deploys ISM before mailbox, while EVM bootstrap
deploys mailbox first because subsequent ISM/hook deployment needs it. Reworking
that orchestration is a later, separate change.

### 5. Migrate submitters into the common interface

Submitters are first-class migration scope because artifact writers only plan
updates; submitters determine how transactions are authorized, wrapped, submitted,
or materialized for later execution.

Provider-sdk should recognize the existing strategy vocabulary even when a
protocol does not support every strategy:

- JSON-RPC
- impersonated account
- file
- multisig transaction proposer
- multisig transaction builder
- interchain account with a nested submitter
- timelock controller with a proposer submitter

The common `ITransactionSubmitter` consumes canonical `AnnotatedTx` values. Each
implementation validates chain, logical sender, and the inner protocol transaction
before acting. ICA and timelock transform the input transactions and delegate the
result to their configured nested submitter.

These names describe intent rather than a product:

```ts
interface MultisigTxProposerConfig {
  type: 'multisigTxProposer';
  chain: string;
  multisigAddress: string;
}

interface MultisigTxBuilderConfig {
  type: 'multisigTxBuilder';
  chain: string;
  multisigAddress: string;
  filepath: string;
}
```

The Ethereum implementation is Safe-backed. The proposer creates and signs a Safe
transaction proposal and sends it to the Safe Transaction Service. The builder
creates a Safe Transaction Builder file and does not propose or execute anything.
The SVM proposer can later use Squads: its proposal creation is on-chain, so it may
return real proposal-creation receipts. Protocol-specific services, formats, vault
addresses, program IDs, and validation remain inside the protocol implementation
and provider context.

The current Safe builder should stop inheriting proposal behavior: it is not a
proposer, does not need a proposal result, and must not return its JSON payload as a
receipt. Existing `gnosisSafe` and `gnosisSafeTxBuilder` strategy values remain
deprecated input aliases that normalize to the generic discriminators during the
compatibility window.

Options considered:

1. **Rename only**: change discriminators but retain Safe-shaped configs and CLI
   branching. Smallest diff, but product coupling remains; not recommended.
2. **Generic intent, protocol-owned implementation**: common proposer/builder
   configs and interfaces; Safe and Squads validate and implement them separately.
   Recommended.
3. **One universal multisig engine**: share proposal construction across Safe and
   Squads. Rejected because Safe proposal is an off-chain service call while Squads
   proposal creation is an on-chain, vault-specific transaction with ALT and
   ordering constraints.

The return contract remains deliberately narrow:

```ts
interface ITransactionSubmitter {
  submit(...transactions: AnnotatedTx[]): Promise<TxReceipt[]>;
}
```

Only genuine on-chain transaction receipts may be returned. JSON-RPC and
impersonated submission return confirmed receipts. Safe-backed multisig proposal,
file, and Safe-backed multisig builder submitters handle their proposal/file
behavior internally and return an empty receipt array. An SVM/Squads proposer may
return the receipts that actually create its on-chain proposals. ICA and timelock
return only genuine receipts from their nested submitter, or an empty array when
that nested path is off-chain.

Failures throw. Proposal metadata, Safe Builder payloads, file paths, and other
off-chain artifacts must never be cast, parsed, exported, or persisted as receipts.
Any batching/finalization needed for those artifacts belongs inside the submitter
implementation or its construction-scoped collaborators.

CLI strategy parsing can remain in CLI initially, but construction routes through
`ProtocolProvider.createSubmitter(context, config)`. Remove
`additionalSubmitterFactories`, EVM/AltVM branching, and transaction casts only
after every supported strategy reaches parity.

Write-facade cutovers depend on this track. Read facades do not.

### 6. Make CLI own protocol registration

Move dynamic protocol loading and registration out of deploy-sdk and into CLI.

Target ownership:

```text
CLI composition root
├── imports protocol packages needed by selected chains
├── registers Ethereum/Tron -> EvmProtocolProvider from SDK
├── registers each existing AltVM provider
└── invokes deploy-sdk through the common registry

deploy-sdk
└── consumes getProtocolProvider(); imports no concrete protocol package
```

Concrete changes:

- Add a CLI-owned loader and switch CLI to it.
- Stop filtering EVM-like chains out in CLI context setup.
- Register both `ProtocolType.Ethereum` and `ProtocolType.Tron` with the SDK-hosted
  facade; current EVM hook/ISM/core modules support both.
- Build provider contexts from `MultiProvider` metadata plus registry addresses.
- Keep concrete package imports at the CLI composition root.
- Remove EVM/AltVM branches command by command after facade parity.

This avoids an SDK ↔ deploy-sdk dependency cycle and keeps deploy-sdk protocol
agnostic. The existing deploy-sdk loader cannot be removed immediately: SDK warp
checking and infra scripts also consume it. Keep it as a deprecated compatibility
shim until those consumers own registration, then remove its concrete protocol
dependencies in a later breaking release.

Do not replace existing EVM signer middleware merely by registering the facade.
Remote signers, strategies, ZkSync, and Tron behavior remain delegated until the
provider-sdk signer configuration can represent them.

### 7. Extract EVM only after facade parity

Once all CLI operations use the common interface and existing E2Es pass:

1. Create the dedicated EVM protocol package.
2. Let it temporarily depend on SDK while it hosts the existing facades; CLI imports
   the EVM package directly.
3. Move actual EVM implementations behind each facade incrementally.
4. Replace delegation with native Artifact API code one artifact/type at a time.
5. Once the EVM package has zero SDK imports, atomically reverse the dependency and
   make SDK provide compatibility reexports from the EVM package.
6. Delete a facade only when no production path or downstream compatibility export
   relies on it.
7. Remove the final SDK compatibility layer after the agreed deprecation window.

This separates two risks:

- first, changing dispatch/interface ownership;
- later, moving and rewriting implementation code.

## Reviewable PR train

Every row is one PR unless marked as a series. A series means one PR per protocol,
artifact cluster, or CLI command. No PR both switches a consumer and deletes its
legacy path.

### Phase A: make the vocabulary safely extensible

| PR  | Scope                                                                                        | Exit gate                                                                                      |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A1  | Make hook manager dispatch explicitly partial and add protocol-owned unsupported-type errors | Existing hook behavior unchanged; every unsupported type fails with protocol and discriminator |
| A2  | Add the complete hook vocabulary to provider-sdk                                             | Provider/SDK discriminator parity test; every protocol package typechecks                      |
| A3  | Prepare ISM dispatch as in A1                                                                | Existing supported ISMs unchanged; unsupported tests pass                                      |
| A4  | Add the complete ISM vocabulary; remove/fix deploy-sdk's five-ISM recognition allowlist      | Nested fixtures round-trip; managers, not global validation, reject unsupported operations     |
| A5  | Prepare warp dispatch as in A1                                                               | Existing four Artifact API token types unchanged                                               |
| A6  | Add the complete token vocabulary                                                            | All current SDK token discriminators represented; conversion fixtures pass                     |

Conversions between SDK chain-name configs and provider artifacts live in SDK/EVM
facade code. Provider-sdk must not import SDK.

### Phase B: provider context and transaction contract

| PR      | Scope                                                                                                                 | Exit gate                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| C1      | Add `ProtocolProviderContext`, structural readonly address type, legacy-input normalization helper; change no factory | Old metadata and new context normalize identically                                                                                          |
| C2a–C2f | One protocol per PR accepts the normalized input in its concrete factories                                            | Protocol unit/E2E tests; old and new inputs behave identically                                                                              |
| C3      | Change the common `ProtocolProvider` factory signatures after every implementation is ready                           | Full TypeScript build; published interface fixture                                                                                          |
| C4      | CLI supplies complete registry address sets for current protocols; no EVM registration                                | Existing AltVM CLI E2Es unchanged                                                                                                           |
| T1      | Add semantic `Tx<T = unknown>` and transaction-shape primitive tests; leave `AnnotatedTx` behavior unchanged          | Additive provider-sdk change; no producer changes                                                                                           |
| T2a–T2g | One protocol per PR adds `assertXTx`, chain/sender checks, raw-payload negative tests, and printable-envelope helpers | No RPC/signing occurs before validation; malformed and cross-protocol inputs fail                                                           |
| T3      | Atomically redefine `AnnotatedTx<T> = Annotated<Tx<T>>` and update all producers/consumers                            | Breaking changeset; full build; all signer/submitter tests; file output retains the full transaction shape; no `as any[]` transaction casts |

T3 is intentionally the one large mechanical PR. A temporary raw/enveloped union
would permit smaller protocol cutovers but contradict the chosen hard boundary and
would allow unvalidated raw transactions to persist.

### Phase C: composition root and EVM runtime facades

| PR  | Scope                                                                          | Exit gate                                                         |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| L1  | Add an idempotent CLI-owned protocol loader with registration-set parity tests | No runtime consumer changed                                       |
| L2  | Switch CLI's existing AltVM registration to its loader                         | Existing AltVM E2Es; deploy-sdk loader still works for SDK/infra  |
| E1  | Add SDK-hosted EVM/Tron provider adapter; register nowhere                     | `MultiProvider` provider/read parity tests                        |
| E2  | Add EVM/Tron signer adapter against final `AnnotatedTx`                        | Sender, chain, calldata/value, ZkSync/Tron characterization tests |

### Phase D: submitter parity

| PR  | Scope                                                                                                                                                                          | Exit gate                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| S1  | Add the complete submitter-config vocabulary using `multisigTxProposer` / `multisigTxBuilder`; retain deprecated Safe-named input aliases; document the receipt-only invariant | Config/schema fixtures for direct, file, multisig, ICA, and timelock nesting                                                  |
| S2  | Adapt provider-sdk JSON-RPC, impersonated, and file submitters to canonical transactions                                                                                       | Single, batch, impersonated, malformed-input, printable-file, and genuine-receipt tests                                       |
| S3  | Add EVM/Tron JSON-RPC, impersonated, and file submitter facades                                                                                                                | Parity for receipts, errors, retry inputs, and sender checks                                                                  |
| S4  | Implement generic multisig proposer/builder with Safe-backed EVM facades; decouple builder from proposer inheritance                                                           | Proposal authorization and internal builder-file parity; both return `[]`, never fake receipts                                |
| S5  | Add ICA and timelock facades with recursive nested-submitter construction                                                                                                      | Same wrapping calldata, origin/destination, logical authority, and genuine nested receipts only                               |
| R1  | Register Ethereum and Tron in CLI, but retain command branches and EVM filtering                                                                                               | Registration/context tests; no user-visible dispatch change                                                                   |
| S6  | Route CLI strategy construction through `ProtocolProvider.createSubmitter`; remove additional EVM/AltVM factory branching                                                      | Main and fee submitters, retries, genuine receipts, internal Safe/file output, self-relay, and strategy tests retain behavior |
| S7  | Follow-up: adapt the existing SVM/Squads proposal pipeline to `multisigTxProposer`; do not block the EVM facade cutover on it                                                  | Vault-authority, ALT, ordering, proposal-index, and genuine proposal-receipt tests                                            |

### Phase E: artifact facades and command cutovers

Hooks and ISMs are separate review trains. ISM writes precede hook writes because
some EVM hook deployments create paired ISMs.

| PR/series | Scope                                                                             | Exit gate                                                                                       |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| I1        | ISM conversions and SDK compatibility aliases                                     | Bidirectional fixtures                                                                          |
| I2        | EVM/Tron ISM read facade                                                          | Differential read parity for every supported type                                               |
| I3        | ISM writer facade; requires S6                                                    | Same target, calldata, value, order, sender, genuine receipts, reuse, and second-apply behavior |
| I4        | Switch ISM read command only                                                      | Ethereum and Tron read E2Es; isolated revert available                                          |
| I5a–I5n   | Switch one ISM write/deploy/apply command per PR                                  | Final-state E2E per command; retain legacy implementation                                       |
| H1–H5     | Repeat I1–I5 for hooks after ISM write and submitter support are available        | Hook differential and CLI E2Es                                                                  |
| W1        | Token conversions and aliases                                                     | Per-token-family fixtures                                                                       |
| W2a–W2n   | Token read facade/cutover by type cluster                                         | Differential reads; mixed EVM/AltVM route checks                                                |
| W3a–W3n   | Token update facade/cutover by type cluster                                       | Transaction and idempotence parity                                                              |
| W4a–W4n   | Token deployment facade/cutover by type cluster                                   | Address, receipt, enrollment, ownership, and route E2Es                                         |
| M1        | Core/mailbox read facade and read cutover                                         | Complete address/config read parity                                                             |
| M2        | Core update facade and apply cutover                                              | Transaction and final-state parity                                                              |
| M3        | High-level core deployment facade and deploy cutover                              | EVM bootstrap order preserved; registry output parity                                           |
| M4a–M4n   | Validator announce, ICA, fees, and remaining core artifacts                       | Separate component E2Es                                                                         |
| B1–Bn     | Remove one now-dead CLI EVM branch per PR                                         | Search proves no consumer; simple isolated revert                                               |
| L3        | Migrate SDK/infra loader consumers to their composition roots                     | Their existing tests pass; deploy-sdk shim remains deprecated                                   |
| L4        | Remove deploy-sdk loader and concrete protocol dependencies in a breaking release | Dependency graph check and major changeset                                                      |

### Phase F: extract and replace facades

| PR/series | Scope                                                                                      | Exit gate                                               |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| X1        | Create EVM package containing facades; it temporarily depends on SDK; CLI imports it       | No behavior change; import compatibility tests          |
| X2a–X2n   | Replace facade delegation with native EVM Artifact API code: ISMs/hooks, tokens, then core | Package-local differential tests and unchanged CLI E2Es |
| X3        | Reach zero imports from EVM package to SDK                                                 | Dependency check                                        |
| X4        | Atomically reverse dependency direction; SDK reexports EVM APIs                            | Public export tests and changesets                      |
| X5a–X5n   | Delete dead facades only after downstream compatibility window                             | Downstream audit; major changeset where required        |

This is a dependency order, not a demand to finish every vocabulary PR before any
independent context or transaction preparation. Independent rows may run in
parallel, but each facade/cutover observes its listed prerequisites.

## Parity gates

Before switching each operation:

- same normalized read result
- same transaction target, calldata, value, order, and signer
- same deployed/reused addresses
- same receipts and registry output
- same genuine broadcast receipts; off-chain proposal/file/payload data never
  appears in receipt output
- same nested ICA/timelock wrapping and logical authority
- same final on-chain state
- second apply is a no-op in both paths
- existing Ethereum CLI E2Es pass
- relevant Tron regressions pass
- mixed EVM/AltVM routes still pass
- every transaction is rejected before RPC use when chain, sender, or raw payload
  is invalid
- file serialization preserves chain, sender, annotation, and printable raw payload

Run old and facade readers/planners side by side in tests. Never execute both write
paths.

## Git-history precedent

Verified mainline sequence:

1. `badb740bb7`: protocol API definition.
2. `ed10fc1c0b`: unified ISM Artifact API.
3. `b0e9d48d78`: generic ISM writers and consumer/protocol integration.
4. `7f31d77078`: Radix/Cosmos hook Artifact API and legacy hook-module removal.
5. `1f021bfef3`: warp protocol managers and wiring.
6. `e1973313e7`: deploy-sdk warp reader/writer integration.
7. `840fb33da6`: CLI warp cutover and deprecated module removal.
8. `a6b7bf3d6e`: core Artifact API implementation.
9. `83767b9675`: core CLI integration and old-module removal.
10. `fa08f2a685`: later removal of obsolete signer/provider methods.

Earlier drafts cited several topic-branch commits as though they were mainline
predecessors. They are not ancestors of current `HEAD` and are intentionally
excluded here.

History supports the broad order—API, implementation, consumer cutover, cleanup—
but several historical PRs combined cutover and deletion. This plan deliberately
improves on that precedent by separating them for easier review and rollback.

## Explicit non-goals for the first migration

- No ProtocolProvider capability-registry redesign.
- No staged transaction-plan redesign.
- No separate transaction-envelope type or temporary raw/enveloped union.
- No protocol-agnostic external `submit` command yet; this migration only supplies
  the typed transaction and submitter foundations it will need.
- No immediate EVM package extraction.
- No rewrite of working EVM deployment logic.
- No removal of SDK APIs before facade parity and a compatibility window.
- No requirement that every protocol implement every newly defined artifact type.

## Unresolved questions

None required to start. The provider-neutral address-set type name and exact SDK
compatibility window can be decided during implementation without changing the
sequence above.
