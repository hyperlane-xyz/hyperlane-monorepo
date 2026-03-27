# SVM Fee Architecture

This document describes the design of the Hyperlane SVM fee system: a separate fee program that computes transfer fees for warp routes, porting EVM fee parity (Linear, Regressive, Progressive, Routing) to Sealevel.

## Overview

The system has two components:

1. **Fee program** (`hyperlane-sealevel-fee`) — a standalone Solana program that manages fee account PDAs and computes fees via its `QuoteFee` instruction.
2. **Warp route integration** (`hyperlane-sealevel-token` library + the three token programs) — an optional `FeeConfig` on the warp route's `HyperlaneToken` account that, when set, triggers a CPI to the fee program during `transfer_remote`.

The fee is additive: the sender pays `amount + fee`. The message encodes `amount` only — the remote chain never sees the fee.

## Fee-on-Top Semantics

The fee is additive ("fee-on-top"): the sender pays `amount + fee(amount)`. The cross-chain message encodes the full transfer `amount` — the fee is never subtracted from it and never crosses chains. This means:

- The recipient receives exactly `amount` (modulo decimal conversions).
- The fee beneficiary receives `fee(amount)` on the source chain in the same transaction.
- SDK/CLI integrators must ensure the sender has sufficient balance for `amount + fee(amount)`. A `QuoteFee` CPI (or off-chain simulation) should be used to determine the total required.
- Setting fee to 0 (via `max_fee=0`, `half_amount=0`, or no route for the domain) makes the transfer behave identically to a fee-less warp route.

## Design Goals

1. **Fee program changes require zero warp route config or program changes.** The warp route stores only `(fee_program, fee_account)` in its `FeeConfig`. Adding new fee types, changing routing structures, or adjusting parameters is entirely within the fee program's domain.
2. **Upgrade-compatible.** Existing deployed warp routes can start charging fees by calling `SetFeeConfig`. No migration, no redeployment.
3. **Low CPI depth.** The fee quote uses one CPI. The fee program reads its own accounts and returns the result via `set_return_data` — no further nesting.
4. **Separation of concerns.** The fee program is a pure calculator + config store. It never touches tokens. The warp route handles all token movements (burn, lock, transfer).

## Fee Types

All fee types share two parameters: `max_fee` (ceiling) and `half_amount` (the transfer amount at which the fee reaches half of `max_fee`). All math uses `u128` intermediates; the result is always rounded down.

| Variant | Formula | Behavior |
|---|---|---|
| **Linear** | `min(max_fee, amount * max_fee / (2 * half_amount))` | Proportional up to a hard cap |
| **Regressive** | `max_fee * amount / (half_amount + amount)` | Decreasing marginal rate, asymptotic to `max_fee` |
| **Progressive** | `max_fee * amount² / (half_amount² + amount²)` | S-curve — small transfers nearly free, large ones approach `max_fee` |
| **Routing** | Per-domain lookup → delegate to leaf fee data | Domain-specific fee curves |

Edge cases: `half_amount == 0` or `max_fee == 0` → fee is 0. The Progressive formula handles potential `u128` overflow via a complement path (`fee = max_fee - max_fee * half_sq / denominator`). If both products overflow (extreme parameters), it returns `IntegerOverflow`.

These are the same fee curves as the EVM implementation in `solidity/contracts/token/fees/`.

## Account Model

### Fee Account

```
PDA seeds: [b"hyperlane_fee", b"-", b"fee", b"-", salt]
```

```rust
struct FeeAccount {
    header: FeeAccountHeader, // bump, owner, beneficiary
    fee_data: FeeData,        // Linear | Regressive | Progressive | Routing
}
```

The `salt` is a user-provided `H256`, enabling multiple fee accounts per program instance. The `beneficiary` is a wallet address — the warp route derives the actual destination account (ATA for SPL tokens, wallet directly for native) at transfer time.

### FeeAccountHeader

`FeeAccountHeader` holds the `(bump, owner, beneficiary)` fields and is embedded as `FeeAccount.header`. Borsh serializes nested structs field-by-field, so the on-chain byte layout is identical to a flat struct.

The warp route uses `AccountData<FeeAccountHeader>::fetch` to partially deserialize only the header from the fee account's raw bytes, discovering the beneficiary without knowing or deserializing the `FeeData` variant. This works because Borsh reads only the bytes needed for the type and ignores trailing data. This is the primary decoupling mechanism: the warp route program never imports `FeeData` and doesn't need to understand fee types.

The header layout `(bump, owner, beneficiary)` is a stable prefix. New fields added after `fee_data` in `FeeAccount` will not break header reads.

### Route Domain PDA (for Routing fee type)

```
PDA seeds: [b"hyperlane_fee", b"-", b"route", b"-", fee_account_key, b"-", &domain.to_le_bytes()]
```

```rust
struct RouteDomain {
    bump: u8,
    fee_data: FeeData,  // inlined — Linear, Regressive, or Progressive
}
```

Each domain gets its own PDA with its own independent fee curve. Uninitialized domains (no route set) return fee = 0.

## Warp Route Integration

### FeeConfig

Stored as `Option<FeeConfig>` on the `HyperlaneToken` account (the last field):

```rust
struct FeeConfig {
    fee_program: Pubkey,
    fee_account: Pubkey,
}
```

Set by the warp route owner via `SetFeeConfig`. Set to `None` to disable fees.

### Backward-Compatible Deserialization

`HyperlaneToken` uses a manual `BorshDeserialize` implementation. After deserializing all existing fields including `plugin_data`, it peeks at the next byte:

- **EOF** (no more data) → `fee_config = None`. This is the legacy account path.
- **Byte == 0** → `Option::None`, fee_config = None. This handles accounts with trailing zero bytes.
- **Byte == 1** → `Option::Some`, deserialize the `FeeConfig` struct.

This means existing deployed warp routes continue to work unchanged. The first time any mutation occurs (enroll router, set gas config, set fee config, etc.), the account is re-serialized with the new format including the `Option<FeeConfig>` suffix.

**Safety**: `AccountData::store_in_slice` zero-fills remaining bytes after serialization, preventing stale data in the trailing region from being misinterpreted as a valid `FeeConfig`.

### Transfer Flow

During `transfer_remote`, if `fee_config` is `Some`:

```
 0..8:  [standard accounts: system, noop, token_pda, mailbox, outbox, dispatch_auth, sender, unique_msg, dispatched_msg]
 F:     fee_program (executable)
 F+1:   fee_account (read)
 F+2..: additional fee accounts (variable length, consumed in a loop)
 S:     fee_beneficiary_account (sentinel — terminates the loop)
 G..:   IGP accounts (if configured)
 P..:   plugin accounts
```

The warp route:

1. Validates `fee_program` and `fee_account` match `FeeConfig`.
2. Reads the `FeeAccountHeader` from the fee account to get the beneficiary.
3. Computes the expected fee beneficiary account key via the plugin's `fee_beneficiary_account_key` method.
4. Loops over accounts until it finds one matching the expected fee beneficiary key (the **sentinel**). Everything before the sentinel is collected as additional fee accounts for the CPI.
5. Builds a `QuoteFee` CPI to the fee program with `(fee_account, ...additional_accounts)`.
6. Reads the fee amount from `get_return_data()`.
7. Passes `(fee_amount, fee_beneficiary_account)` to the plugin's `transfer_in`.

The plugin then handles the actual token movement: burn/lock the transfer `amount`, and separately transfer `fee_amount` to the fee beneficiary.

### Sentinel Termination

The sentinel approach eliminates the need for a stored account count. The warp route doesn't need to know how many additional accounts the fee program requires — it just loops until it hits the fee beneficiary account. This means:

- Adding new fee types that require more accounts (e.g., a hypothetical multi-hop routing) requires **zero warp route config changes**.
- `next_account_info` returns `NotEnoughAccountKeys` if the sentinel is never found, failing safely.

The expected sentinel key is computed via the plugin's `fee_beneficiary_account_key` method, which derives the destination from the beneficiary wallet (read from the fee account header):

| Plugin | Returns |
|---|---|
| Native | `beneficiary` directly (SOL goes to the wallet) |
| Synthetic | `ATA(beneficiary, mint, spl_token_2022)` |
| Collateral | `ATA(beneficiary, mint, spl_token_program)` |

The beneficiary is a wallet address stored in the fee account. The caller passes the actual destination account (wallet or ATA). The sentinel loop verifies the key matches — an attacker cannot substitute a different account without controlling both the fee account data and the warp route's `FeeConfig`.

### Fee Payment in Plugins

Each plugin's `transfer_in` received two new parameters: `fee_amount: u64` and `fee_beneficiary_account: Option<&AccountInfo>`. When `fee_amount > 0`:

- **Synthetic**: `burn_checked(amount)` from sender ATA, then `transfer_checked(fee_amount)` from sender ATA to fee beneficiary ATA.
- **Collateral**: `transfer_checked(amount)` from sender ATA to escrow, then `transfer_checked(fee_amount)` from sender ATA to fee beneficiary ATA.
- **Native**: `system_transfer(amount)` from sender to collateral PDA, then `system_transfer(fee_amount)` from sender to fee beneficiary wallet.

Fees flow directly from sender to beneficiary in the same transaction — no escrow, no claim step.

## CPI Depth

```
Direct call:
Warp route (0)
  → Fee QuoteFee (1) ← reads accounts, set_return_data, no further CPI
  → SPL burn/transfer + fee transfer (1) ← sequential, same depth
  → Mailbox dispatch (1)
    → IGP pay_for_gas (2)
      → system_program (3)

Via router:
Router (0) → Warp route (1) → Fee/SPL/Mailbox (2) → IGP (3) → system (4)
```

Max depth: 4 (the SVM limit). The fee CPI doesn't deepen the call stack beyond what already exists — it's at the same level as the Mailbox dispatch and SPL token calls.

## Alternatives Considered

### Inline fee computation (rejected)

Warp route reads fee accounts directly and computes fees without CPI. Saves one CPI depth level. **Rejected** because it creates compile-time coupling: the warp route must import `FeeData`, understand all fee variants, and be upgraded whenever a new fee type is added. The CPI approach keeps the warp route fully agnostic to fee program internals.

### Count-based additional accounts (rejected)

Store `additional_fee_account_count: u8` in `FeeConfig`. The warp route loops exactly N times. **Rejected** because changing fee type (e.g., Linear → Routing) changes the count, requiring a warp route config update. Violates the zero-config-change goal.

### Read count from fee account data at transfer time (rejected)

Warp route deserializes the fee account to determine the account count. Simpler than sentinel but creates the same compile-time coupling as inline computation — the warp route must understand every `FeeData` variant to know the count. New fee types require warp route program upgrades.

### Pointer-based routing (replaced with inlined fee data)

Early design: `RouteDomain` stored a `Pubkey` pointing to a separate delegated fee account. `QuoteFee` required 3 accounts for routing: fee account + route PDA + delegated fee account. **Replaced** with inlining `FeeData` directly into the route PDA:

- **Fewer accounts**: routing QuoteFee needs 2 accounts instead of 3.
- **No dangling references**: route PDA is self-contained; no risk of pointing to a closed account.
- **Same flexibility**: each domain still gets independent fee curve and parameters.

Tradeoff: updating a fee curve shared across N domains requires N `SetRoute` calls instead of one `UpdateFeeData` on a shared account. Acceptable — domain-level tuning is the common case, and bulk updates are infrequent.

### Fee account as escrow + claim (rejected)

Fees accumulate on the fee account PDA; a `Claim` instruction withdraws them. **Rejected** because: the fee program would need to be SPL-token-aware for claims, require ATAs for PDAs, and add an extra transaction for withdrawals. Direct payment to the beneficiary is simpler and provides immediate settlement.

### Beneficiary stored in warp route FeeConfig (rejected)

Early design stored `fee_beneficiary: Pubkey` in the warp route's `FeeConfig`. **Rejected** because rotating the beneficiary would require updating every warp route's config. Storing beneficiary in the fee account means one `SetBeneficiary` call updates it for all warp routes sharing that fee account.

### Separate FeeConfig PDA instead of HyperlaneToken field (rejected)

Store fee config in a separate PDA per warp route program, avoiding any `HyperlaneToken` schema change. **Rejected** because: it requires an additional PDA derivation in every `transfer_remote` (even when fees aren't configured), doesn't follow the existing pattern (IGP config is stored directly in `HyperlaneToken`), and the manual `BorshDeserialize` approach handles backward compatibility cleanly with zero migration.

## Realloc on Route Overwrite

Different `FeeData` variants have different serialized sizes (e.g., `Linear` = 17 bytes, `Routing` = 1 byte). `SetRoute` uses `store_with_rent_exempt_realloc` to resize the route domain PDA and adjust rent when overwriting with a different variant size.

## Route Removal

`RemoveRoute` zeros the route PDA's data, transfers its lamports to a specified recipient, and re-assigns ownership to the system program. The runtime garbage-collects the 0-lamport account between transactions. Within the same transaction, `data_len` may remain > 0 but `QuoteFee` handles this by checking both `data_is_empty()` and `owner == system_program`, returning fee = 0 for removed routes.

## Security Notes

- **Fee account ownership check**: `verify_fee_account` checks `owner == fee_program_id` but does not re-derive the PDA (the salt is not available at runtime). Security relies on the fee account address being pinned in `FeeConfig` (set by the warp route owner) and validated before CPI.
- **Sentinel loop bounds**: The loop is bounded by the transaction's account list. `next_account_info` fails with `NotEnoughAccountKeys` if the sentinel is never found. A caller providing extra accounts before the sentinel only wastes their own compute — the fee CPI determines what's valid.
