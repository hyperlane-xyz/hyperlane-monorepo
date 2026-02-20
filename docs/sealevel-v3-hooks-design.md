# Sealevel V3 Hooks Design

## Context

Hyperlane v3 moved from a model where the sender calls the Mailbox then separately calls the IGP, to a model where the Mailbox invokes "post-dispatch hooks" via CPI — a required hook and a default hook. The required hook is typically a MerkleTreeHook, the default hook is typically an IGP wrapped in an aggregation with a pausable hook.

V3 is implemented on all VMs except Solana (Sealevel). This doc captures the design decisions for the Sealevel v3 hook migration.

## Solana Constraints

### CPI depth limit

- Max 4 nested invokes (invoke 0 = top-level instruction, invoke 4 = deepest allowed, invoke 5 = error)
- A program cannot re-invoke itself (no reentrant CPI) — so Mailbox -> Hook -> Mailbox is impossible

### Account limits

- All accounts must be declared upfront in the transaction
- Callers need an account discovery mechanism to know what accounts hooks require

### Heap limit

- 32KB BPF heap — HashMap deserialization with >~55 entries causes OOM
- Existing IGP stores per-domain gas oracles in a `HashMap<u32, GasOracle>` that's fully deserialized on every call

## Key Design Decisions

### 1. Merkle tree stays in the Mailbox

On EVM, MerkleTreeHook is a separate contract the Mailbox calls. On Solana, this would require reentrant CPI (Mailbox -> MerkleTreeHook -> Mailbox to insert) which is impossible.

Decision: The Mailbox's `dispatch_v3` instruction inserts into the merkle tree inline, same as v2. This means:

- No reentrant CPI needed
- Validators don't change — same Outbox PDA, same tree, same checkpoint signing
- No dual-tree problem

### 2. Protocol fee stays in the Mailbox

Already implemented in the Sealevel Mailbox. Keep it in `dispatch_v3` rather than factoring it out as a hook.

### 3. Pausable is NOT baked into the Mailbox

Pausable should be a hook concern, not a Mailbox concern. The Mailbox dispatches messages; whether dispatch is paused is a policy decision the hook layer owns.

### 4. The IGP program is upgraded to be the canonical hook program

Rather than creating a separate "hooks program" and a separate IGP, upgrade the existing IGP program to also implement the hook interface. This gives us:

- Backward compatibility — existing `PayForGas` callers keep working
- Relayer indexes the same program, same gas payment PDAs
- The hook program handles pausable, routing, aggregation, and IGP logic internally — no aggregation wrapper CPI needed
- One CPI from Mailbox covers all hook logic

New instruction variants are added alongside existing ones:

- `PostDispatch { metadata, message }` — the hook entry point
- `QuoteDispatch { metadata, message }` — fee estimation
- `PostDispatchAccountMetas { metadata, message }` — account discovery (same pattern as ISM account metas)

### 5. HookConfig is (program_id, hook_config_pda)

The Outbox PDA stores:

```rust
pub struct Outbox {
    // ...existing fields...
    pub default_hook: HookConfig,   // (program_id, config_pda)
    pub required_hook: HookConfig,  // (program_id, config_pda)
}
```

- The Mailbox CPIs to whatever program_id is in the HookConfig
- Any program implementing the hook interface can be a hook
- Callers can override the default hook in `dispatch_v3` (same as EVM v3)
- The required hook always runs regardless

### 6. dispatch_v3 is a new instruction variant (backward compat)

The existing `OutboxDispatch` instruction stays exactly as-is. A new `OutboxDispatchV3` instruction is added with hook-related accounts. Same Outbox PDA, same merkle tree, same nonce sequence.

### 7. Per-domain gas oracle PDAs fix the HashMap OOM

The existing IGP stores all gas oracles in one `HashMap<u32, GasOracle>` — fully deserialized on every call, OOMs at ~55 domains.

Fix: store each gas oracle in its own PDA:

```
seeds: [igp_salt, domain_id_le_bytes, "gas-oracle"]
```

- `PostDispatch` reads only the one PDA for the message's destination domain — O(1) memory
- Scales to unlimited domains
- Existing `PayForGas` continues reading the HashMap — backward compatible, 55-domain ceiling is acceptable for legacy callers
- `PostDispatchAccountMetas` returns the correct per-domain PDA for account discovery

Migration: `SetRemoteGasData` instruction writes per-domain PDAs. Optionally also writes to the HashMap for backward compat during transition.

## CPI Depth Analysis

### Typical flow (no router):

```
Token program (invoke 0)
  -> Mailbox dispatch_v3 (invoke 1)     [inserts merkle tree inline]
       -> IGP/HookProgram (invoke 2)    [checks pause, computes gas, does aggregation internally]
            -> system_program (invoke 3) [lamport transfer for gas payment]
```

Max depth: 3. Comfortable.

### With a router above the token:

```
Router (invoke 0)
  -> Token (invoke 1)
       -> Mailbox dispatch_v3 (invoke 2)
            -> IGP/HookProgram (invoke 3)
                 -> system_program (invoke 4)  ← at the limit but allowed
```

Max depth: 4. Still works. Token programs remain composable.

### Mailbox calls hooks sequentially, not nested:

If both required_hook and default_hook are configured, the Mailbox calls them one after the other:

```
Mailbox -> required_hook (depth N+1)   ← returns
Mailbox -> default_hook (depth N+1)    ← sequential, same depth
```

Each hook gets the full depth budget from the Mailbox.

## Account Discovery

Same pattern as ISMs. Off-chain flow for building a `dispatch_v3` transaction:

1. Read Outbox PDA → get `required_hook` and `default_hook` configs
2. Simulate `HookProgram.PostDispatchAccountMetas` for each hook config
3. Build transaction with discovered accounts
4. Use marker-based account segmentation to delimit required hook accounts vs default hook accounts in the instruction

For programs that CPI into dispatch (warp route tokens), their `TransferRemoteAccountMetas` chains into the hook's `PostDispatchAccountMetas`.

## What Solana v3 Hooks Lose vs EVM

- Hooks can't be fully arbitrary nested external programs (CPI depth is scarce)
- MerkleTreeHook isn't a "hook" — it's baked into the Mailbox
- Deep hook composition (aggregation of aggregations) is limited
- The IGP/hook program consolidates logic that would be separate contracts on EVM

## What We Gain

- CPI depth budget is well-managed
- Single merkle tree, no validator migration
- Account discovery is a proven pattern
- V2 backward compat is clean
- Per-domain PDAs fix the 55-domain scaling limit
- Existing relayer indexing doesn't change
