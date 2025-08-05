# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a Rust implementation of Hyperlane for the Kaspa blockchain, part of the Dymension ecosystem. It enables cross-chain messaging between Kaspa and other chains through the Hyperlane protocol.

Key components:
- **Mailbox**: Handles message processing and batching for withdrawals from Hub to Kaspa
- **Providers**: WRPC client for Kaspa node connection, REST API client for indexer queries
- **Validators**: Manages validator signatures for multi-sig operations
- **Indexers**: Track deposits, withdrawals, and other on-chain events

## Common Development Commands

### Building and Testing

```bash
# Build the library
cargo build

# Build with all features
cargo build --all-features

# Run tests
cargo test

# Check code without building
cargo check

# Format code
cargo fmt

# Run linter
cargo clippy
```

### Running Individual Components

```bash
# Run the validator server (from rust/main directory)
cargo run --bin validator -- [OPTIONS]

# Run the relayer (from rust/main directory)
cargo run --bin relayer -- [OPTIONS]
```

## Architecture Overview

### Connection Configuration (`src/conf.rs`)
- `ConnectionConf`: Main configuration struct containing:
  - Kaspa WRPC URLs for direct node connection
  - Kaspa REST URLs for higher-level indexer queries
  - Validator public keys for multi-sig operations
  - Hub gRPC URLs for Dymension chain connection
  - Minimum deposit amounts and operation submission config

### Provider Layer (`src/providers/`)
- `KaspaProvider`: Main provider implementing HyperlaneChain and HyperlaneProvider traits
- `RestProvider`: Handles REST API calls to Kaspa indexer
- `ValidatorsClient`: Manages communication with validator nodes for signature collection
- Uses `EasyKaspaWallet` for transaction signing and submission

### Mailbox Implementation (`src/mailbox.rs`)
- Implements batched message processing via `process_batch()`
- Handles withdrawal transactions from Hub to Kaspa
- Checks delivery status by querying the Hub
- Returns hardcoded ISM address since Kaspa doesn't have smart contracts

### Key Workflows

1. **Withdrawal Processing**:
   - Relayer receives withdrawal messages from Hub
   - Constructs Kaspa transactions using the escrow wallet
   - Collects signatures from validators
   - Combines signatures and submits transactions to Kaspa
   - Updates confirmation status on the Hub

2. **Deposit Monitoring**:
   - Indexers watch for deposits to the escrow address
   - Events are indexed and made available to relayers

3. **Multi-sig Operations**:
   - Uses Schnorr signatures for Kaspa multi-sig
   - Threshold-based signing (e.g., 2-of-3)
   - Validators sign withdrawal transactions independently

## Important Notes

- Kaspa clients must connect via WRPC to a node with GRPC server and UTXO index enabled
- The node must be fully synced for transaction submission to work
- Minimum deposit amounts are enforced to prevent dust transactions
- All amounts are in sompi (smallest Kaspa unit, 1 KAS = 100,000,000 sompi)
- Uses a fork of rusty-kaspa with payload support in PSKT
- Relies on external Kaspa libraries from `dymension/libs/kaspa/`

## Testing Approach

- Unit tests: `cargo test` in the module directory
- Integration tests require running Kaspa node and Hub
- Test configurations available in `dymension/tests/kaspa_hub_test_kas/`

## Dependencies

- Uses workspace dependencies defined in parent Cargo.toml
- Key external dependencies:
  - `kaspa-*` crates from forked rusty-kaspa
  - `hyperlane-core` for core protocol types
  - `hyperlane-cosmos-native` for Hub communication
  - `dym-kas-*` libraries for Kaspa-specific functionality