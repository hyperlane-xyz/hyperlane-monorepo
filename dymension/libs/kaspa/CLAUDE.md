# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a Rust library for Kaspa blockchain integration with Hyperlane, part of the Dymension fork of the Hyperlane monorepo. It provides:

- **Core functionality**: Shared logic for validators and relayers to interact with Kaspa blockchain
- **Multisig support**: Implementation of validator multisig escrow for cross-chain transfers
- **PSKT (Partially Signed Kaspa Transactions)**: Support for cooperative transaction construction
- **Hyperlane integration**: Bridge between Kaspa and other chains via Hyperlane protocol

The library uses a fork of rusty-kaspa with payload support in PSKT for memo functionality.

## Common Development Commands

### Building and Testing

```bash
# Build all workspace members
cargo build

# Build in release mode
cargo build --release

# Run tests
cargo test

# Run tests with output
cargo test -- --nocapture

# Build specific binary
cargo build --release --bin <binary-name>
```

### Running Demos

```bash
# Multisig demo
cd demo/multisig
cargo run  # generates private key, needs funding
cargo run -- -r  # run with existing funded key

# Relayer demo
cd demo/relayer
cargo run

# User demo
cd demo/user
cargo run
```

### Kaspa Node Operations

```bash
# Run kaspad node (requires config file)
cargo run --release --bin kaspad -- -C <config.toml>

# Access CLI wallet
cd wallet/native
cargo run
```

## Architecture Overview

### Workspace Structure

- **`lib/core`**: Shared types and logic for both validators and relayers
  - API client for Kaspa blockchain
  - Balance management
  - Deposit/withdrawal logic
  - PSKT utilities
  - Wallet management

- **`lib/relayer`**: Relayer-specific functionality
  - Confirmation handling
  - Deposit processing
  - Hub-to-Kaspa withdrawals

- **`lib/validator`**: Validator-specific functionality
  - Transaction signing
  - Multisig participation
  - Withdrawal validation

- **`lib/api`**: Generated OpenAPI client for Kaspa blockchain API

- **`lib/hardcode`**: Hardcoded test data and configurations

- **`demo/`**: Self-contained demonstrations
  - `multisig`: Basic multisig + relayer flow
  - `relayer`: Relayer operations demo
  - `user`: User operations and simulations

### Key Concepts

1. **WRPC Connection**: Clients must connect to Kaspa nodes via WRPC (WebSocket RPC). The node must have:
   - GRPC server enabled
   - UTXO index available
   - Be fully synced

2. **Multisig Flow**:
   - Validators create keypairs and collaborate to generate multisig redeem script
   - Users escrow funds to the multisig address
   - Relayer constructs PSKT with ANYONE_CAN_PAY for escrow inputs
   - Validators sign their portions
   - Relayer combines signatures and broadcasts

3. **Transaction Construction**:
   - Uses P2SH (pay-to-script-hash) for multisig
   - Supports up to N=20 validators
   - Transaction IDs don't include script signatures (no SegWit)

### Important Technical Details

- **Units**: 1 KAS = 100,000,000 sompis (similar to Bitcoin's satoshis)
- **Addresses**: Three types - schnorr, ecdsa, script (multisig uses script/P2SH)
- **Payload**: Transactions can include arbitrary data in the payload field
- **Script Version**: Always 0 for script public keys

## Development Workflow

1. **For Core Library Changes**:
   - Modify code in `lib/core/src/`
   - Run `cargo test` in lib/core
   - Test with demos to verify integration

2. **For Agent Implementation**:
   - Modify relayer code in `lib/relayer/src/`
   - Modify validator code in `lib/validator/src/`
   - Test with respective demos

3. **For API Updates**:
   - OpenAPI spec is in `scripts/open-api/openapi.json`
   - Generated code is in `lib/api/src/`

## Testing Approach

- Unit tests: `cargo test` in each library crate
- Integration tests: Run demos with local or testnet nodes
- TestNet 10 endpoint: https://api-tn10.kaspa.org/
- TestNet 10 faucet: https://faucet-tn10.kaspanet.io/

## Important Notes

- Always ensure Kaspa node is fully synced before testing
- WRPC connection is required for wallet operations
- Transaction construction requires understanding of UTXO model
- Multisig operations require coordination between validators
- Check existing patterns in demos before implementing new features