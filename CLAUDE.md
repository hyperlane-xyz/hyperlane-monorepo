# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Hyperlane is an interchain messaging protocol that enables applications to communicate between blockchains. The monorepo contains three main components working together:

1. **Smart Contracts (Solidity)** - Core on-chain messaging infrastructure
2. **TypeScript SDK** - Developer tools and multi-protocol abstractions
3. **Rust Agents** - Off-chain relayer network and validator infrastructure

## Development Commands

### Building

```bash
# Build everything using Turbo
pnpm build

# Build specific workspaces
pnpm -C solidity build          # Solidity contracts with Hardhat + Forge
pnpm -C typescript/sdk build    # TypeScript SDK
cd rust/main && cargo build        # Rust agents
```

### Testing

```bash
# Run all tests
pnpm test

# Solidity tests
pnpm -C solidity test           # Both Hardhat and Forge tests
pnpm -C solidity test:hardhat   # Hardhat tests only
pnpm -C solidity test:forge     # Forge tests only

# TypeScript SDK tests
pnpm -C typescript/sdk test     # Unit, Hardhat, and Foundry tests
pnpm -C typescript/sdk test:unit

# Rust tests
cd rust/main && cargo test

# End-to-end testing
cd rust/main && cargo run --release --bin run-locally
```

### Linting & Formatting

```bash
pnpm lint                          # Lint all workspaces
pnpm prettier                      # Format all workspaces
pnpm -C solidity lint           # Solidity-specific linting with solhint
cd rust/main && cargo clippy       # Rust linting
```

### Development Workflows

```bash
# Solidity development
pnpm -C solidity hardhat-esm compile    # Compile contracts
pnpm -C solidity fixtures               # Generate test fixtures
forge test -vvv --decode-internal          # Detailed Forge testing

# Generate gas snapshots
pnpm -C solidity gas

# Run single Rust test
cd rust/main && cargo test <test_name>

# Run specific VM E2E tests
cargo test --release --package run-locally --features cosmos -- cosmos::test --nocapture
cargo test --release --package run-locally --features sealevel -- sealevel::test --nocapture
```

## Architecture

### Message Flow

1. **Dispatch**: Applications send messages via `Mailbox.dispatch()` on origin chain
2. **Index**: Rust relayer agents index dispatched messages from chain events
3. **Security**: Relayers fetch required security metadata from validators/ISMs
4. **Delivery**: Messages are delivered to destination `Mailbox.process()` with proofs
5. **Handle**: Destination applications receive messages via `IMessageRecipient.handle()`

### Core Contracts (`solidity/contracts/`)

**Mailbox** (`Mailbox.sol`)

- Central hub for message dispatch and processing
- Maintains merkle tree of dispatched messages
- Processes inbound messages with security verification

**Interchain Security Modules** (`isms/`)

- Pluggable security verification (multisig, merkle proofs, etc.)
- Each destination can specify its required security model
- Key types: `MultisigIsm`, `MerkleRootMultisigIsm`, `AggregationIsm`

**Hooks** (`hooks/`)

- Post-dispatch processing (gas payments, etc.)
- `MerkleTreeHook`: Maintains message merkle tree
- `InterchainGasPaymaster`: Handles gas fee payments

**Token Bridge** (`token/`)

- `HypERC20`: Native token implementations
- `HypERC20Collateral`: Wrapped/collateral token implementations
- Multi-chain token deployments with unified liquidity

### TypeScript SDK (`typescript/sdk/src/`)

**Core Abstractions**

- `MultiProvider`: Multi-chain provider management with protocol adapters
- `HyperlaneCore`: Factory for core contract interactions
- `MultiProtocolCore`: Protocol-agnostic abstractions (EVM, Cosmos, Sealevel, Starknet)

**Key Patterns**

- `ChainMap<T>`: Type-safe per-chain configuration mapping
- `MultiProtocolProvider`: Unified interface across different VMs
- Adapter pattern for protocol-specific implementations

### Rust Agents (`rust/main/`)

**Agent Types**

- **Relayer** (`agents/relayer/`): Indexes origin chains, delivers messages to destinations
- **Validator** (`agents/validator/`): Signs checkpoints for message verification
- **Scraper** (`agents/scraper/`): Indexes chain data for analytics

**Chain Support** (`chains/`)

- `hyperlane-ethereum`: EVM chain support
- `hyperlane-cosmos`: Cosmos ecosystem support
- `hyperlane-sealevel`: Solana/SVM support
- `hyperlane-fuel`: Fuel VM support

**Architecture**

- `hyperlane-core`: Core traits and message types
- `hyperlane-base`: Shared agent utilities and configuration
- Chain-specific implementations provide VM-specific contract interactions

## Key Concepts

**Domain**: Unique identifier for each blockchain (not the same as chain ID)

**Message**: Core data structure containing sender, recipient, origin/destination domains, and body

**ISM (Interchain Security Module)**: Pluggable security verification - destinations choose their security requirements

**Hook**: Post-dispatch processing module (gas payments, message indexing, etc.)

**Checkpoint**: Validator-signed commitment to a message merkle root at specific index

**Gas Price Escalation**: Automatic gas price increases for stuck transactions using formula: `Max(Min(Max(Escalate(oldGasPrice), newEstimatedGasPrice), gasPriceCapMultiplier × newEstimatedGasPrice), oldGasPrice)` - preventing indefinite escalation while maintaining competitiveness and ensuring RBF compatibility. The `gasPriceCapMultiplier` is configurable per chain in transactionOverrides (default: 3)

## Configuration Files

- `rust/main/config/`: Contains chain configurations for mainnet/testnet deployments
- Contract addresses and deployment metadata automatically synced from these configs
- Agents automatically discover and use all configurations in this directory

## Incident Debugging & Operations

When debugging Hyperlane operational incidents (stuck messages, RPC failures, validator issues, gas problems, warp route imbalances, etc.), **always check the documentation in `docs/ai-agents/operational-debugging.md`** first. This contains:

- **AI-powered debugging workflows** using Grafana and GCP logging integration
- **Grafana dashboard analysis** with key panels for incident triage (Easy Dashboard, Validator Dashboards, Lander Dashboard, RPC Usage & Errors)
- **Progressive GCP log query strategies** to efficiently analyze logs with minimal token usage
- **Error pattern recognition and decoding techniques** (gas estimation failures, validator delays, RPC issues)
- **Hyperlane Explorer integration** for finding stuck messages before querying logs
- **Specific debugging workflows** for common incident types (queue length alerts, CouldNotFetchMetadata errors, RPC provider issues, etc.)

**Manual Operations Runbook**: The comprehensive [Operations Runbook](https://www.notion.so/hyperlanexyz/Runbook-AI-Agent-24a6d35200d680229b38e8501164ca66) contains detailed procedures for:

- Agent deployment and redeployment procedures
- RPC URL rotation when providers fail
- Validator operations and reorg recovery
- Manual message processing and retry procedures
- Balance management and key funding
- Security incident response protocols
- Lander (transaction submitter) configuration and troubleshooting
