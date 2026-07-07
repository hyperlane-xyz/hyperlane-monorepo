# Composite ISM

A composable Interchain Security Module (ISM) for Solana/SVM. A single program
deployment stores a tree of ISM nodes in one PDA account, allowing operators to
express arbitrary verification logic without deploying multiple programs.

## The Core Problem: Account Discovery

SVM requires all accounts a transaction touches to be declared upfront, but the
accounts a complex ISM tree needs are only knowable after reading those accounts
— a chicken-and-egg problem.

The solution is a **fixpoint simulation loop** driven by the relayer. The relayer
calls `VerifyMetadataSpec` repeatedly, each time providing more accounts, until
the ISM returns a fully resolved `MetadataSpec`:

```
relayer calls VerifyMetadataSpec(extra_accounts=[])
  → spec: None, need: [domain_pda]

relayer calls VerifyMetadataSpec(extra_accounts=[domain_pda])
  → spec: None, need: [domain_pda, fallback_vam_pda, fallback_ism]

relayer calls VerifyMetadataSpec(extra_accounts=[domain_pda, fallback_vam_pda, fallback_ism])
  → spec: Some(MultisigMessageId { validators, threshold }), done!
```

Only once `spec: Some(...)` is returned does the relayer know the metadata format
and can build and submit the real `Verify` transaction with the correct accounts.

The loop converges in at most `D + 1` passes, where `D` is the number of
account-bearing ISM nodes (`Routing`, `FallbackRouting`) in the active path
through the tree.

## Architecture

### Storage

All config lives in the **VAM PDA** (derived from
`VERIFY_ACCOUNT_METAS_PDA_SEEDS`). This is the account the relayer's simulation
framework already knows to query. It stores an `IsmNode` tree serialized with
Borsh.

`Routing` and `FallbackRouting` nodes are the exception: each origin domain's
ISM override is stored in a separate **domain PDA** at seeds
`[b"domain_ism", &domain.to_le_bytes()]`. The VAM PDA holds only the node
variant itself; domain PDAs are created, updated, and closed with
`SetDomainIsm` / `RemoveDomainIsm` instructions.

### ISM node types

| Variant | Behavior |
|---|---|
| `TrustedRelayer { relayer }` | Accepts if `relayer` is a signer on the transaction. |
| `MultisigMessageId { validators, threshold }` | ECDSA threshold multisig over `CheckpointWithMessageId`. Validators and threshold are stored inline. |
| `Aggregation { threshold, sub_isms }` | m-of-n: at least `threshold` sub-ISMs must have metadata provided and must verify. |
| `AmountRouting { threshold, lower, upper }` | Routes to `upper` if the TokenMessage amount >= threshold, else `lower`. |
| `Routing` | Routes to the per-domain PDA for the message's origin. Fails with `NoRouteForDomain` if no domain PDA exists for that origin. |
| `FallbackRouting { fallback_ism }` | Same as `Routing`, but if no domain PDA override exists, delegates to `fallback_ism` via CPI. The fallback can be any deployed Hyperlane ISM, including legacy multisig ISMs. |
| `RateLimited { max_capacity, recipient }` | Enforces a rolling 24-hour token transfer cap. State (`filled_level`, `last_updated`) is stored inline in the VAM PDA. |
| `Pausable { paused }` | Emergency circuit breaker. Rejects all messages when `paused = true`. |
| `Test { accept }` | Always accepts or always rejects. Testing only. |

### Routing and FallbackRouting

`Routing` and `FallbackRouting` both look up a per-domain PDA for the message's
origin domain. The difference is what happens when no domain PDA is configured:

- **`Routing`** — hard fails with `NoRouteForDomain`.
- **`FallbackRouting { fallback_ism }`** — CPIs into the `fallback_ism` program's
  `VerifyMetadataSpec` (or `Verify`) to delegate resolution. This is how a
  composite ISM can wrap a default ISM (e.g. a legacy multisig) while allowing
  per-domain overrides.

#### Domain PDA management

1. **`SetDomainIsm`** — creates/updates the PDA at
   `[b"domain_ism", &origin.to_le_bytes()]` for a given origin domain.
2. **`Verify`** — the relayer passes the domain PDA as an extra account; the
   program reads it and dispatches to the sub-ISM stored inside.
3. **`RemoveDomainIsm`** — closes the domain PDA and returns rent to the owner.
   Subsequent messages for that domain fall through to the fallback (or fail if
   using plain `Routing`).

#### FallbackRouting account layout

Because `Routing` and `FallbackRouting` are the only nodes that consume accounts
from the `extra_accounts` slice, and at most one such node may exist in the
tree, the account positions are always fixed:

| Position | Account |
|---|---|
| `extra_accounts[0]` | Domain PDA for the message's origin |
| `extra_accounts[1]` | Fallback ISM's VAM PDA (FallbackRouting only, fallback path) |
| `extra_accounts[2..]` | Accounts required by the fallback ISM itself |

For a **legacy multisig** fallback ISM, `extra_accounts[2]` is the multisig
program's domain data PDA (validators/threshold are read directly from it). For
a **new ISM** implementing `VerifyMetadataSpec`, the accounts at `[2..]` are
whatever that ISM requests through its own fixpoint loop — which is fully
independent of the outer composite ISM's account space.

### Instructions

| Instruction | Description |
|---|---|
| `Initialize` | Creates the VAM PDA and sets the root ISM node. |
| `UpdateConfig` | Replaces the root ISM node. |
| `SetDomainIsm` | Creates or updates the domain PDA for a `Routing`/`FallbackRouting` node. |
| `RemoveDomainIsm` | Closes a domain PDA, returning rent to the owner. |
| `TransferOwnership` | Changes the owner stored in the VAM PDA. |
| `GetOwner` | Returns the current owner (simulation only). |
| `Verify` | Verifies a message against the ISM tree. |
| `VerifyAccountMetas` | Returns the account list needed by `Verify` (simulation only). |
| `VerifyMetadataSpec` | Returns the metadata format expected by the tree and the accounts still needed (simulation only). Drives the fixpoint loop described above. |
| `Type` | Returns the Hyperlane `ModuleType` of the root node (simulation only). |

## Limitations

- **At most one `Routing` or `FallbackRouting` node in the entire tree.**
  Config validation rejects any tree that contains more than one such node
  anywhere (`MultipleRoutingNodes` error). This is required because both node
  types read from fixed positions in `extra_accounts` starting at index 0; a
  second such node would conflict over the same position.

- **`Routing`/`FallbackRouting` are not allowed inside a domain PDA.**
  `SetDomainIsm` rejects any ISM subtree that contains either variant
  (`RoutingInDomainIsm` / `FallbackRoutingInDomainIsm` error). Domain PDAs may
  contain `MultisigMessageId`, `Aggregation`, `AmountRouting`, `TrustedRelayer`,
  `RateLimited`, and `Test` nodes only.

- **`Pausable` is not allowed inside a domain PDA.**
  `Pause` and `Unpause` traverse only the root storage PDA — all accounts a
  Solana transaction touches must be declared upfront, so propagating pause
  state to an unbounded number of domain PDAs would require enumerating every
  domain and passing their accounts in one transaction. Solana's 1232-byte
  packet limit (32 bytes per pubkey) makes this infeasible for deployments with
  many domains, and splitting it across multiple transactions would mean the
  pause is not atomic. `Pausable` is therefore restricted to the root tree where
  it can be flipped in a single account, single transaction operation.
  To freeze a specific domain route, call `SetDomainIsm` with
  `Test { accept: false }` for that domain.

  Additionally, `set_paused` does **not** affect the external `fallback_ism`
  program referenced by a `FallbackRouting` node. The fallback ISM is an
  independent program with its own state; pausing this composite ISM does not
  pause it. To pause the fallback path, call the pause instruction on the
  fallback ISM program directly.

- **`RateLimited` requires a specific warp-route recipient.** The node parses a
  token amount from a fixed offset in the TokenMessage body, so it only makes
  sense when bound to a known warp-route contract. Config validation rejects
  `recipient: None` and `recipient: H256::zero()` (`InvalidConfig` error). The
  configured address is checked on every `Verify` call — messages to any other
  recipient are rejected with `RecipientMismatch`.

- **`RateLimited` must live in the root ISM tree, not inside a fallback ISM.**
  Capacity mutation is gated on the process authority PDA derived per ISM program
  (`derive_process_authority(mailbox, program_id)`). The mailbox signs only the
  authority of the ISM it invokes directly (the root composite ISM), never a
  nested fallback ISM reached by CPI, so a `RateLimited` node inside a fallback
  ISM demands a signer that can never be produced and its messages are
  undeliverable.

- **`RateLimited` requires its containing PDA to be writable.** When the ISM
  tree (or a domain PDA) contains a `RateLimited` node, `VerifyAccountMetas`
  marks the relevant PDA writable. Callers must pass that account as writable in
  the `Verify` transaction.

- **`MultisigMessageId` validator sets are stored inline in the node.**
  For scale, the intended pattern is `Routing` or `FallbackRouting` with a
  `MultisigMessageId` inside each domain PDA, so each origin's validator set is
  isolated to its own account.

## Solana-specific scale limits

These are validated by the BPF scale tests in `tests/functional_big_isms.rs`
(run with the compiled `.so` binary so real BPF constraints apply):

| Limit | Constraint | Observed headroom |
|---|---|---|
| Compute budget | 1,400,000 CU per transaction | 200 domains + 3 secp256k1 recoveries: ~135k CU (90% headroom) |
| Heap | 32 KB per BPF invocation | 50-sub-ISM Aggregation fits comfortably |
| Call depth | 64 BPF frames | 16 levels of nested Aggregation: 17 frames |
| `Verify` metadata tx size | 1,232 bytes (Solana packet limit) | See note below |

**Transaction size is the binding constraint for deep multisig trees.** A
`Routing → Aggregation(3-of-3)[Aggregation(3-of-3)[MultisigMessageId(3v,3)] ×3]`
config produces ~2463 bytes of metadata — exceeding the 1232-byte Solana packet
limit. The ISM logic itself executes correctly (~1.14M CU), but the `Verify`
transaction cannot be submitted on mainnet as a single packet.

The packet size limit is a network/UDP constraint, not a runtime constraint.
`solana-program-test` does not enforce it. The scale tests check tx size
explicitly by asserting on the serialized transaction length.

**Practical guidance:**
- Each 3-of-N MultisigMessageId produces 263 bytes of verify metadata (32 + 32 + 4 + 65×3).
- A single-level `Aggregation(K)[MultisigMessageId(3v,3)]` fits within 1232 bytes for K ≤ 3.
- Deeper trees require out-of-band metadata delivery or restructuring into smaller configs.
