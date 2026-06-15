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

### Hyperlane Message-Recipient Interface

The program implements the Hyperlane message-recipient interface for EVM→Solana
destination swaps using a commit/reveal pattern:

1. **Warp bridge** — EVM side bridges tokens to Solana via Hyperlane warp route
2. **Commit message** — EVM side dispatches a 96-byte commit body:
   `commitment(32) || salt(32) || recipient(32)`
   - Creates a `PendingSwap` PDA funded by the program's `fee_payer_pda`
3. **Reveal message** — EVM side dispatches the swap instructions:
   `salt(32) || pda_token_ata(32) || borsh(commands, inputs)(N)`
   - Verifies commitment, executes swap, closes PDA

### Key PDAs

| PDA | Seeds | Purpose |
|-----|-------|---------|
| `fee_payer_pda` | `[b"hyperlane_fee_payer"]` | Pre-funded, pays rent for PendingSwap creation |
| `pending_swap` | `[b"pending_swap", origin_domain_le, sender_bytes32, salt]` | Stores in-flight swap state |

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
(101 bytes ≈ 0.0016 SOL each). Fund it once during deployment:

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

## Relationship to universal-router-sealevel

This is a native-Rust port of the Anchor program at
`universal-router-sealevel/programs/universal-router`. Key differences:

| Anchor version | Native version |
|---------------|----------------|
| `#[derive(Accounts)]` | Manual account validation |
| `CpiContext` | `invoke` / `invoke_signed` |
| `#[account]` (8-byte discriminator) | Raw Borsh, no discriminator |
| `AnchorDeserialize` | `borsh::BorshDeserialize` |
| `#[error_code]` | `#[repr(u32)]` + `num_derive` |
| Anchor ISM/handle macros | `MessageRecipientInstruction::decode()` |

`PendingSwap` size: 101 bytes (vs 109 in Anchor due to 8-byte discriminator removal).
