# Composite ISM

A composable Interchain Security Module (ISM) for Solana/SVM. A single program
deployment stores a tree of ISM nodes in one PDA account, allowing operators to
express arbitrary verification logic without deploying multiple programs.

## Architecture

### Storage

All config lives in the **VAM PDA** (derived from
`VERIFY_ACCOUNT_METAS_PDA_SEEDS`). This is the account the relayer's simulation
framework already knows to query. It stores an `IsmNode` tree serialized with
Borsh.

`Routing` nodes are the exception: each origin domain's ISM is stored in a
separate **domain PDA** at seeds `[b"domain_ism", &domain.to_le_bytes()]`. The
VAM PDA holds only the `Routing` node itself (plus an optional `default_ism`);
domain PDAs are created, updated, and closed with `SetDomainIsm` /
`RemoveDomainIsm` instructions.

### ISM node types

| Variant | Behavior |
|---|---|
| `TrustedRelayer { relayer }` | Accepts if `relayer` is a signer on the transaction. |
| `MultisigMessageId { validators, threshold }` | ECDSA threshold multisig over `CheckpointWithMessageId`. Validators and threshold are stored inline. Domain routing is handled by an outer `Routing` node. |
| `Aggregation { threshold, sub_isms }` | m-of-n: at least `threshold` sub-ISMs must have metadata provided and must verify. |
| `AmountRouting { threshold, lower, upper }` | Routes to `upper` if the TokenMessage amount >= threshold, else `lower`. |
| `Routing { default_ism }` | Routes to a per-domain PDA for the message's origin. Falls back to `default_ism` if no domain PDA exists. See below. |
| `RateLimited { max_capacity, recipient }` | Enforces a rolling 24-hour token transfer cap. State (`filled_level`, `last_updated`) is stored inline in the VAM PDA. |
| `Pausable { paused }` | Emergency circuit breaker. Rejects all messages when `paused = true`. |
| `Test { accept }` | Always accepts or always rejects. Testing only. |

### Routing PDA resolution

Because SVM programs cannot allocate unbounded heap, storing all domain->ISM
mappings inline in the VAM PDA would OOM at ~100 domains. `Routing` instead
stores each domain's ISM in its own account:

1. **`SetDomainIsm`**: creates/updates the PDA at
   `[b"domain_ism", &origin.to_le_bytes()]` for a given origin domain.
2. **Verify**: the relayer passes the domain PDA for the message origin as an
   extra account; the program reads it and dispatches to the sub-ISM inside.
3. **`RemoveDomainIsm`**: closes the domain PDA and returns rent to the owner.
   Subsequent messages for that domain fall back to `default_ism`.

#### Two-pass VerifyAccountMetas for TrustedRelayer

When a domain PDA contains a `TrustedRelayer` node, the relayer cannot know the
relayer pubkey from a single `VerifyAccountMetas` call (the domain PDA hasn't
been read yet). The relayer must loop:

1. Call `VerifyAccountMetas` with `[storage_pda]` → returns `[storage_pda, domain_pda]`.
2. Call `VerifyAccountMetas` again with `[storage_pda, domain_pda]` → handler
   reads the domain PDA and appends the relayer pubkey.
3. Repeat until the returned pubkey set stabilizes (fixpoint).

This loop converges in at most `depth + 1` iterations where `depth` is the
nesting level of account-bearing ISMs inside the domain PDA.

### Instructions

| Instruction | Description |
|---|---|
| `Initialize` | Creates the VAM PDA and sets the root ISM node. |
| `UpdateConfig` | Replaces the root ISM node. |
| `SetDomainIsm` | Creates or updates the domain PDA for a `Routing` node. |
| `RemoveDomainIsm` | Closes a domain PDA, returning rent to the owner. |
| `TransferOwnership` | Changes the owner stored in the VAM PDA. |
| `GetOwner` | Returns the current owner (simulation only). |
| `Verify` | Verifies a message against the ISM tree. |
| `VerifyAccountMetas` | Returns the account list needed by `Verify` (simulation only). |
| `GetMetadataSpec` | Returns the metadata format expected by the tree (simulation only). |
| `Type` | Returns the Hyperlane `ModuleType` of the root node (simulation only). |

## Limitations

- **At most one `Routing` node per composite ISM.** Having two `Routing` nodes
  anywhere in the VAM PDA tree is rejected at `UpdateConfig` time
  (`MultipleRoutingNodes` error).

- **`Routing` is not allowed inside a domain PDA.** `SetDomainIsm` rejects any
  ISM subtree that contains a `Routing` node (`RoutingInDomainIsm` error). This
  also means you cannot nest two `Routing` ISMs within the same composite ISM
  deployment.

- **`RateLimited` requires its containing PDA to be writable.** When the ISM
  tree (or a domain PDA) contains a `RateLimited` node, `VerifyAccountMetas`
  marks the relevant PDA (storage PDA or domain PDA) writable. Callers must
  ensure that account is passed as writable in the `Verify` transaction.

- **No cross-program delegation.** `IsmNode` has no variant that references an
  external program. You cannot embed a call to a separate composite ISM
  deployment inside the tree.

- **`MultisigMessageId` validator sets are stored inline in the node.**
  For scale, the intended pattern is `Routing` with a `MultisigMessageId` inside
  each domain PDA, so each origin's validator set is isolated to its own account.

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
