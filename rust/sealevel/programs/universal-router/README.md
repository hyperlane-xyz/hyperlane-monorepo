# Hyperlane Universal Router — Solana (Native Rust)

A command-based swap and bridge router for Solana, implementing the same
interface as the EVM Uniswap UniversalRouter. Ported from the Anchor-based
[universal-router-sealevel](https://github.com/hyperlane-xyz/universal-router-sealevel)
project to native Rust using the existing Hyperlane sealevel infrastructure types
(no Anchor dependency).

## Architecture

### Commands

| Byte | Command | Description |
|------|---------|-------------|
| `0x00` | `RAYDIUM_CLMM_SWAP_EXACT_IN` | Raydium concentrated-liquidity swap |
| `0x01` | `RAYDIUM_AMM_SWAP_EXACT_IN` | Raydium AMM v4 swap |
| `0x08` | `WRAP_SOL` | Wrap SOL into wSOL |
| `0x09` | `UNWRAP_WSOL` | Unwrap wSOL back to SOL |
| `0x0a` | `SWEEP` | Transfer full token balance to recipient |
| `0x0b` | `TRANSFER` | Transfer fixed token amount |
| `0x12` | `BRIDGE_TOKEN` | Bridge tokens via Hyperlane warp route |
| `0x13` | `EXECUTE_CROSS_CHAIN` | Dispatch cross-chain commit+reveal to EVM ICA |
| `0x21` | `EXECUTE_SUB_PLAN` | Execute a nested command batch |

Bit 7 of each command byte is `FLAG_ALLOW_REVERT` — set it to allow that command
to fail without reverting the entire transaction.

### EVM→Solana Destination Swap Flow

The program implements the Hyperlane message-recipient interface to support
EVM→Solana cross-chain swaps using a commit/reveal pattern:

```
EVM                                    Solana
────────────────────────────           ──────────────────────────────────
1. bridge tokens ──────────────────►  warp-route ATA (owned by pending_swap PDA)
2. dispatch Commit message ────────►  handle_commit → creates pending_swap PDA
3. dispatch Reveal message ────────►  handle_reveal → executes swap, closes PDA
```

The two-message design separates the commitment (created before token arrival
is confirmed) from the execution (triggered once tokens are bridged). The
`pending_swap` PDA address itself serves as the commitment proof — no extra
hash verification is needed at execution time.

### PDAs

| PDA | Seeds | Purpose |
|-----|-------|---------|
| `fee_payer_pda` | `[b"hyperlane_fee_payer"]` | Pre-funded; pays rent when `pending_swap` is created |
| `pending_swap` | `[b"pending_swap", origin_domain_le_bytes(4), sender_bytes32(32), commitment(32)]` | Stores in-flight swap state (45 bytes); one per unique commitment |

`commitment = keccak256(borsh(commands, inputs) ‖ salt)`

The commitment is keyed by origin domain + sender + commitment hash, so multiple
in-flight swaps from the same EVM sender coexist without collision.

### Commit Message (`handle_commit`)

**Trigger**: body length == 96 bytes

**Body layout**:
```
commitment (bytes 0..32)  — keccak256(borsh(swap commands, inputs) || salt)
salt       (bytes 32..64) — caller-chosen nonce (unused on-chain; already hashed into commitment)
recipient  (bytes 64..96) — Solana wallet that receives output tokens on success
```

**Account layout** (after mailbox process authority):
```
[0] process_authority  signer    — mailbox process authority PDA (verified)
[1] fee_payer_pda      writable  — program PDA that funds PendingSwap creation
[2] pending_swap       writable  — PDA created here; must not already exist
[3] system_program
```

**Behaviour**:
1. Verifies `accounts[0]` is the expected mailbox process authority PDA.
2. Parses `commitment` (bytes 0..32) and `recipient` (bytes 64..96) from body.
3. Derives `pending_swap` PDA from `[PENDING_SWAP_SEED, origin_le, sender, commitment]`.
4. Rejects with `CommitmentAlreadySet` if the PDA account is non-empty.
5. Creates the 45-byte `pending_swap` account via CPI to system program, funded by `fee_payer_pda`.
6. Writes `PendingSwap { recipient, origin_domain, bump, commit_time }` (raw Borsh, no discriminator).

### Reveal (`RouterInstruction::Reveal`)

Direct reveal called by the relayer (not via the mailbox).

**Account layout**:
```
[0] pending_swap PDA   writable  — verified by re-deriving from ix fields
[1] pda_token_ata      writable  — ATA holding bridged tokens; must be owned by pending_swap PDA
[2] fee_payer_pda      writable  — receives rent from PDA + ATA on close
[3] recipient_ata      writable  — receives tokens on swap failure fallback
[4] token_program      readonly  — SPL Token or Token-2022
[5] mint               readonly  — required for transfer_checked
[6] system_program     readonly
[7..] swap command accounts      — accounts consumed by dispatcher::execute_commands
```

**Behaviour**:
1. Recomputes `commitment = keccak256(salt ‖ message)` from the instruction fields.
2. Derives `pending_swap` PDA and verifies `accounts[0]` matches.
3. Verifies `fee_payer_pda` matches `accounts[2]`.
4. Verifies `pda_token_ata` is owned by the `pending_swap` PDA with non-zero balance.
5. Decodes `message` as `borsh(Vec<u8>, Vec<Vec<u8>>)` = `(commands, inputs)`.
6. Calls `dispatcher::execute_commands` with the `pending_swap` PDA as the signing authority.
7. **If the swap succeeds**: closes `pending_swap`, rent → `fee_payer_pda`.
8. **If the swap fails**: transfers all remaining tokens from `pda_token_ata` → `recipient_ata` via `transfer_checked`, closes `pda_token_ata` (rent → `fee_payer_pda`), closes `pending_swap` (rent → `fee_payer_pda`), and returns `Ok(())` — the transaction still succeeds with tokens delivered directly to the recipient.

### ClosePendingSwap (`RouterInstruction::ClosePendingSwap`)

Recovers tokens and rent from an orphaned `pending_swap` PDA. Typically called when a reveal was never submitted after tokens arrived.

**Account layout**:
```
[0] pending_swap PDA   writable  — closed; rent → accounts[6]
[1] caller             writable signer — anyone; triggers the close (pays tx fee, not rent)
[2] pda_ata            writable  — tokens → recipient_ata, rent → accounts[6]
[3] recipient_ata      writable  — receives tokens; owner always verified against swap.recipient
[4] token_program      readonly  — SPL Token or Token-2022
[5] mint               readonly  — required for transfer_checked
[6] recipient          writable  — must match swap.recipient; receives all rent
```

**Authorization**: anyone (signer) may call, but only after `now >= swap.commit_time + 3600` (1 hour after commit). This applies to the recipient too — no one can close the PDA early.

**Behaviour**:
1. Verifies `accounts[0]` matches the PDA derived from instruction fields.
2. Loads `PendingSwap` state (recipient, commit_time, bump) from the account.
3. Verifies `accounts[6]` key == `swap.recipient`.
4. Verifies `recipient_ata` owner == `swap.recipient`.
5. Checks `now >= swap.commit_time + 3600`; returns `SwapNotExpired` if not.
6. Transfers any remaining tokens from `pda_ata` → `recipient_ata` via `transfer_checked`.
7. Closes `pda_ata` — rent → `accounts[6]` (recipient).
8. Closes `pending_swap` — rent → `accounts[6]` (recipient).

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) v1.18+
- [Cargo build-sbf](https://docs.solana.com/developing/on-chain-programs/developing-rust#cargo-build-sbf)

## Building

```bash
# From the monorepo sealevel workspace root
cd rust/sealevel

# Check only (fast, no output binary)
cargo check -p hyperlane-sealevel-universal-router

# Build the on-chain .so
cargo build-sbf --manifest-path programs/universal-router/Cargo.toml

# The compiled program is at:
# target/sbf-solana-solana/release/hyperlane_sealevel_universal_router.so
```

## Testing

Unit tests live alongside the source code. Integration / localnet tests require
a running Solana test validator.

```bash
# Unit tests (host target, no BPF runtime)
cargo test -p hyperlane-sealevel-universal-router

# Run with output
cargo test -p hyperlane-sealevel-universal-router -- --nocapture
```

For end-to-end tests against a local validator, use the existing Hyperlane
sealevel test harness:

```bash
# From rust/sealevel
cargo test -p hyperlane-sealevel-token -- --test integration
```

## Deployment

### 1. Generate a Keypair

```bash
solana-keygen new -o keypair.json
```

### 2. Update the Program ID

Replace the `declare_id!` value in [src/lib.rs](src/lib.rs) with the public key
from your keypair:

```bash
solana address -k keypair.json
# Copy the output (e.g. 2CttnaLkYbNHbaFDFnQ8PMCnzUwTGrKnskBxPM4TRWGp)
```

Edit `src/lib.rs`:
```rust
solana_program::declare_id!("<YOUR_PROGRAM_ID>");
```

Rebuild after changing the ID.

### 3. Deploy

```bash
# Target network (change URL as needed)
CLUSTER=https://api.mainnet-beta.solana.com

# Airdrop SOL if deploying to devnet/testnet
solana airdrop 2 --url devnet

# Deploy
solana program deploy \
  --keypair keypair.json \
  --url $CLUSTER \
  target/sbf-solana-solana/release/hyperlane_sealevel_universal_router.so
```

### 4. Fund the Fee Payer PDA

The `fee_payer_pda` must be pre-funded to cover rent for PendingSwap accounts
(45 bytes, minimum rent-exempt balance ≈ 0.0011 SOL each). Fund it once during deployment:

```bash
# Derive the fee_payer_pda address
PROGRAM_ID=<YOUR_PROGRAM_ID>
FEE_PAYER_PDA=$(solana find-program-derived-address $PROGRAM_ID "hyperlane_fee_payer")

# Transfer SOL to fund swap operations (adjust amount as needed)
solana transfer $FEE_PAYER_PDA 1 --allow-unfunded-recipient --url $CLUSTER
```

### 5. Upgrades

```bash
# Build the new version
cargo build-sbf --manifest-path programs/universal-router/Cargo.toml

# Upgrade the deployed program
solana program deploy \
  --keypair keypair.json \
  --program-id $PROGRAM_ID \
  --url $CLUSTER \
  target/sbf-solana-solana/release/hyperlane_sealevel_universal_router.so
```

## Configuring Constants

The following addresses in [src/constants.rs](src/constants.rs) are mainnet
defaults and should be updated for devnet/testnet deployments:

| Constant | Default | Description |
|----------|---------|-------------|
| `HYPERLANE_MAILBOX_PROGRAM_ID` | mainnet mailbox | Hyperlane mailbox program |
| `RAYDIUM_CLMM_PROGRAM_ID` | mainnet CLMM | Raydium concentrated liquidity |
| `RAYDIUM_AMM_V4_PROGRAM_ID` | mainnet AMM v4 | Raydium AMM |
| `HYPERLANE_USDC_TOKEN_ROUTER` | mainnet router | USDC warp route |
| `HYPERLANE_USDT_TOKEN_ROUTER` | mainnet router | USDT warp route |
| `USDC_MINT` / `USDT_MINT` | mainnet mints | Token mint addresses |

## Encoding Swap Instructions

The `execute` instruction takes:
- `commands: Vec<u8>` — command bytes (one per command)
- `inputs: Vec<Vec<u8>>` — Borsh-encoded input struct per command

Example (TypeScript SDK):

```typescript
import { BorshCoder } from '@coral-xyz/anchor'; // or use borsh directly

// WRAP_SOL then RAYDIUM_CLMM_SWAP_EXACT_IN
const commands = [0x08, 0x00];
const inputs = [
  borsh.serialize({ amount: 'u64' }, { amount: 1_000_000n }), // WrapSolInput
  borsh.serialize(
    { amount_in: 'u64', amount_out_minimum: 'u64', sqrt_price_limit_x64: 'u128', is_base_input: 'bool' },
    { amount_in: 1_000_000n, amount_out_minimum: 900_000n, sqrt_price_limit_x64: 0n, is_base_input: true }
  ),
];
```
