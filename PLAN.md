# Plan: SVM MultiCollateral Implementation

## Context

PRs #8246/#8248 introduce MultiCollateral for EVM. Goal: port to SVM so we can deploy SVM MC programs and use `warp combine` identically to EVM.

## Decisions

- Same-chain: CPI (atomic, no mailbox). Compute overhead ~200k CU, acceptable.
- Program ID = router address (32 bytes), consistent with existing SVM warp routes.
- Fees: configurable `ITokenFee`-equivalent program. Start with static fee, design for `IMultiCollateralFee` extensibility.
- Build on xeno097's artifact API (#8219, #7969, #7972).
- Separate program binary (4th alongside synthetic, collateral, native).
- Token 2022 inherited from CollateralPlugin, no concerns.

---

## Phase 1: SVM MultiCollateral Program (Rust)

New crate: `rust/sealevel/programs/hyperlane-sealevel-token-multicollateral/`

### 1a. Data Model

```rust
// In library: HyperlaneToken<T> extended or new wrapper
pub struct MultiCollateralData {
    pub enrolled_routers: HashMap<u32, Vec<H256>>,  // domain → additional routers
    pub fee_program: Option<Pubkey>,                 // Optional fee program (CPI target)
    pub local_domain: u32,                           // For same-chain detection
}
```

Combined with existing `HyperlaneToken<CollateralPlugin>` fields (remote_routers, mailbox, decimals, etc.).

### 1b. Instructions

```rust
// New instructions (on top of base token instructions)
EnrollRouters(Vec<(u32, H256)>),       // owner-only, batch add
UnenrollRouters(Vec<(u32, H256)>),     // owner-only, batch remove
TransferRemoteTo {                     // transfer to specific enrolled router
    destination_domain: u32,
    recipient: H256,
    amount_or_id: u64,
    target_router: H256,
},
HandleLocal {                          // CPI target for same-chain swaps
    origin_domain: u32,
    sender: H256,
    message: Vec<u8>,                  // TokenMessage bytes
},
SetFeeProgram(Option<Pubkey>),         // owner-only, set fee CPI target
```

### 1c. `handle()` — Accept Enrolled Routers

Modify router validation in `transfer_from_remote()`:

```
// Current: sender must match remote_routers[origin]
// New: sender must match remote_routers[origin] OR enrolled_routers[origin]
token.ensure_valid_router_or_enrolled(origin, sender)
```

### 1d. `transfer_remote_to()` — Core New Logic

```
1. Validate target_router is enrolled for destination_domain
2. transfer_in(sender, amount)  — escrow collateral from sender
3. Scale amount: local_amount_to_remote_amount()
4. If fee_program set: CPI to fee program for quote, charge fee
5. If destination == local_domain:
     CPI → target_program.handle_local(local_domain, self_id, TokenMessage)
   Else:
     mailbox.dispatch(destination, target_router, TokenMessage)
     If IGP: pay_for_gas()
```

### 1e. `handle_local()` — Same-Chain CPI Target

```
1. Verify caller program ID ∈ enrolled_routers[local_domain]
   (use Solana's get_caller_program_id or check instruction introspection)
2. Decode TokenMessage(recipient, amount)
3. remote_amount_to_local_amount(amount)
4. transfer_out(recipient, local_amount)  — release collateral to recipient
```

### 1f. Fee Program Interface

New crate: `rust/sealevel/programs/hyperlane-sealevel-token-fee/` (or in library)

Simple static fee to start:

```rust
pub struct TokenFeeConfig {
    pub owner: Pubkey,
    pub default_fee_bps: u16,           // Basis points, e.g., 10 = 0.1%
    pub router_fees: HashMap<(u32, H256), u16>,  // (domain, router) → bps override
}

// CPI interface: quote_fee(destination, recipient, amount, target_router) → fee_amount
// Extensible: swap static impl for routing fee impl later (IMultiCollateralFee equivalent)
```

The MC program CPIs into the fee program to get a quote, then deducts from transfer amount (or requires additional token approval).

---

## Phase 2: Library Changes

File: `rust/sealevel/libraries/hyperlane-sealevel-token/`

### 2a. accounts.rs

- Add `enrolled_routers: HashMap<u32, Vec<H256>>` to token account struct
- Add `fee_program: Option<Pubkey>`, `local_domain: u32`
- Add `is_enrolled_router(domain, router) -> bool`
- Update Borsh serialization (backward-compatible: new fields at end, versioned if needed)

### 2b. instruction.rs

- Add `EnrollRouters`, `UnenrollRouters`, `TransferRemoteTo`, `HandleLocal`, `SetFeeProgram` variants
- Add instruction builder functions for TS client

### 2c. processor.rs

- `enroll_routers()`: owner check, add to HashMap, realloc PDA
- `unenroll_routers()`: owner check, remove, realloc PDA
- `transfer_remote_to()`: validate enrollment, transfer_in, scale, fee CPI, dispatch or CPI
- `handle_local()`: validate caller, decode, scale, transfer_out
- `set_fee_program()`: owner check, update

---

## Phase 3: TypeScript SDK

### 3a. Token Type + Standard

- Add `TokenStandard.SealevelHypMultiCollateral`
- Register in all standard arrays + maps

### 3b. SealevelHypMultiCollateralAdapter

`typescript/sdk/src/token/adapters/SealevelMultiCollateralAdapter.ts`

Extends `SealevelHypCollateralAdapter`:

- `getEnrolledRouters(domain): Promise<string[]>`
- `populateTransferRemoteToTx(dest, recipient, amount, targetRouter)`
- `enrollRouters(pairs: {domain, router}[]): Promise<Transaction>`
- `unenrollRouters(pairs)`
- Account list builder for `TransferRemoteTo` (includes target program accounts for same-chain CPI)

### 3c. WarpCore

- PR #8248's `getMultiCollateralTransferTxs()` detects SVM protocol → uses `SealevelHypMultiCollateralAdapter`
- Same-chain: adapter builds `TransferRemoteTo` with `localDomain`; program handles CPI internally

---

## Phase 4: Tooling (Artifact API)

### 4a. SVM Artifact Manager

Following xeno097's pattern from #8219, add to `svm-provider` (or wherever #8219 lands):

```typescript
// SvmMultiCollateralTokenReader
// - Reads enrolled_routers from PDA
// - Reads fee_program config
// - Inherits collateral reading (mint, escrow, decimals)

// SvmMultiCollateralTokenWriter
// - EnrollRouters / UnenrollRouters transactions
// - SetFeeProgram transaction
// - Inherits collateral writing

// SvmMultiCollateralArtifactManager (facade)
```

### 4b. Deploy-SDK Integration

In deploy-sdk (building on #7969):

- `WarpTokenReader` handles `multiCollateral` type for SVM
- `WarpTokenWriter` generates enrollment transactions
- `createWarpArtifactManager()` returns `SvmMultiCollateralArtifactManager` for MC type

### 4c. `warp combine` Compatibility

`warp combine` (PR #8248) works if:

1. SVM MC deploys with `type: multiCollateral` in config
2. Reader returns `enrolledRouters` field
3. Writer executes `EnrollRouters` instruction via artifact API
4. Deploy-sdk `WarpTokenWriter.update()` handles enrolled router diff

Flow:

```
warp deploy USDC-solana → config A
warp deploy USDT-solana → config B
warp combine --routes "A,B" → merged config with cross-enrollment
warp apply → EnrollRouters CPI on each program
```

### 4d. Cross-Protocol (EVM + SVM)

Works naturally: both use `type: multiCollateral`, both use bytes32 addresses. `warp combine` cross-enrolls EVM↔SVM. `warp apply` handles mixed-protocol enrollment (EVM txs + SVM txs).

---

## Phase 5: Testing

- **Rust unit**: enrollment CRUD, transfer_remote_to (enrolled/unenrolled), handle with enrolled sender, handle_local CPI validation, decimal scaling, fee charging
- **Rust integration**: two MC programs on same localnet, same-chain swap, cross-chain via test mailbox
- **CLI E2E**: `warp deploy` MC on SVM, `warp combine` two SVM routes, `warp apply`, `warp send --source-token --destination-token`
- **Cross-protocol E2E**: EVM MC + SVM MC combined route, transfer both directions

---

## Implementation Order

1. **Phase 1+2**: Rust program + library (core logic, unit-testable)
2. **Phase 3**: SDK types + adapter (TS bindings)
3. **Phase 4a-b**: Artifact manager + deploy-sdk (depends on #8219 landing)
4. **Phase 4c-d**: warp combine integration
5. **Phase 5**: E2E tests throughout

---

## Dependencies

- **xeno097 #8219** (SvmWarpArtifactManager) — Phase 4 builds on this
- **xeno097 #7969** (deploy-sdk warp artifact API) — Phase 4b
- **xeno097 #7972** (client integration) — Phase 4c
- **PR #8248** (MultiCollateral SDK/CLI) — Phase 3c, 4c (warp combine must land first or in parallel)
