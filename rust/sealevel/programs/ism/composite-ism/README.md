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
| `MultisigMessageId { domain_configs }` | ECDSA threshold multisig over `CheckpointWithMessageId`. Validators and threshold are stored inline per origin domain. |
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

- **`RateLimited` is not allowed inside a domain PDA.** `RateLimited` writes
  its state back to the VAM PDA after each `Verify`. Domain PDAs are read-only
  at verify time, so a `RateLimited` node inside one cannot persist its state
  (`RateLimitedInDomainIsm` error).

- **`RateLimited` requires the VAM PDA to be writable.** When the ISM tree
  contains a `RateLimited` node, `VerifyAccountMetas` marks the storage PDA
  writable. Callers must ensure the account is passed as writable in the
  `Verify` transaction.

- **No cross-program delegation.** `IsmNode` has no variant that references an
  external program. You cannot embed a call to a separate composite ISM
  deployment inside the tree.

- **`MultisigMessageId` domain configs are stored inline in the VAM PDA.**
  The node holds a flat `Vec<DomainConfig>` — one entry per origin domain,
  each containing the full validator set and threshold. For a large number of
  origins or large validator sets, the VAM PDA can grow significantly. The
  intended pattern for scale is `Routing` + a single-domain `MultisigMessageId`
  inside each domain PDA, so each origin's validator set is isolated to its own
  account.
