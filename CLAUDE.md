# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Overview

Hyperlane is an interchain messaging protocol that enables applications to communicate between blockchains. The monorepo contains three main components:

1. **Smart Contracts (Solidity)** - Core on-chain messaging infrastructure in `solidity/`
2. **TypeScript Packages** - SDK, CLI, and infrastructure tooling in `typescript/`
3. **Rust Agents** - Off-chain relayer and validator infrastructure in `rust/`

## Quick Reference

### Most Common Commands

```bash
# Build everything
pnpm build

# Run all tests
pnpm test

# Lint and format
pnpm lint && pnpm prettier

# Solidity tests (both Hardhat and Forge)
pnpm -C solidity test

# TypeScript SDK tests
pnpm -C typescript/sdk test

# Rust tests
cd rust/main && cargo test

# CLI e2e tests (useful for testing warp routes, core deployments)
pnpm -C typescript/cli test:ethereum:e2e
```

### Before Committing

```bash
pnpm lint          # Must pass
pnpm prettier      # Auto-formats code
pnpm test          # Run relevant tests
pnpm changeset     # Add changeset if modifying published packages
```

### Changeset Style

Write changeset descriptions in past tense describing what changed, not what will change:

```
# Good - describes what was done
The registry code is restructured by moving filesystem components to a dedicated directory. ESLint restrictions added to prevent Node.js imports in browser components.

# Bad - describes what will happen
Restructures the registry code. Adds ESLint restrictions.
```

## Repository Structure

```
├── solidity/              # Smart contracts (Hardhat + Forge)
│   ├── contracts/         # Solidity source files
│   │   ├── Mailbox.sol    # Core messaging hub
│   │   ├── isms/          # Interchain Security Modules
│   │   ├── hooks/         # Post-dispatch hooks
│   │   └── token/         # Warp route token contracts
│   └── test/              # Contract tests
├── typescript/
│   ├── sdk/               # Core SDK (@hyperlane-xyz/sdk)
│   ├── cli/               # Hyperlane CLI tool
│   ├── infra/             # Infrastructure and deployment scripts
│   ├── utils/             # Shared utilities (@hyperlane-xyz/utils)
│   └── [other packages]/  # cosmos-sdk, widgets, etc.
├── rust/
│   └── main/              # Rust agents monorepo
│       ├── agents/        # Relayer, Validator, Scraper
│       ├── chains/        # Chain-specific implementations
│       └── config/        # Agent configuration files
└── starknet/              # Starknet contracts
```

## Development Commands

### Building

```bash
pnpm build                              # Build all packages (uses Turbo)
pnpm -C solidity build                  # Build Solidity contracts
pnpm -C typescript/sdk build            # Build TypeScript SDK
cd rust/main && cargo build             # Build Rust agents
```

### Testing

```bash
# Solidity
pnpm -C solidity test                   # Both Hardhat and Forge tests
pnpm -C solidity test:hardhat           # Hardhat only
pnpm -C solidity test:forge             # Forge only
forge test -vvv --decode-internal       # Detailed Forge output

# TypeScript
pnpm -C typescript/sdk test             # SDK tests
pnpm -C typescript/sdk test:unit        # Unit tests only
pnpm -C typescript/cli test:ethereum:e2e  # CLI e2e tests

# Rust
cd rust/main && cargo test              # All Rust tests
cd rust/main && cargo test <test_name>  # Single test

# E2E (runs local chains + agents)
cd rust/main && cargo run --release --bin run-locally
```

### Linting & Formatting

```bash
pnpm lint                               # Lint all packages
pnpm prettier                           # Format all packages
pnpm -C solidity lint                   # Solidity linting (solhint)
cd rust/main && cargo clippy            # Rust linting
cd rust/main && cargo fmt               # Rust formatting
```

### Solidity-Specific

```bash
pnpm -C solidity hardhat-esm compile    # Compile contracts
pnpm -C solidity fixtures               # Generate test fixtures (required before forge tests)
pnpm -C solidity gas                    # Generate gas snapshots
pnpm -C solidity coverage               # Coverage report
pnpm -C solidity storage                # Storage layout analysis
forge test --match-test <pattern>       # Run specific Forge tests
```

### CLI Development

```bash
# Install CLI globally from local build
pnpm -C typescript/cli build && npm link

# Run CLI commands
hyperlane --help
hyperlane core deploy --help
hyperlane warp deploy --help
```

## Architecture

### Message Flow

1. **Dispatch**: Applications call `Mailbox.dispatch()` on origin chain
2. **Index**: Relayer agents index dispatched messages from chain events
3. **Security**: Relayer fetches metadata from validators/ISMs
4. **Delivery**: Messages delivered to `Mailbox.process()` on destination
5. **Handle**: Recipient contract receives message via `IMessageRecipient.handle()`

### Core Contracts (`solidity/contracts/`)

| Contract      | Purpose                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `Mailbox.sol` | Central hub for dispatch/process, maintains merkle tree                                  |
| `isms/*`      | Interchain Security Modules - pluggable verification (MultisigIsm, AggregationIsm, etc.) |
| `hooks/*`     | Post-dispatch processing (MerkleTreeHook, InterchainGasPaymaster)                        |
| `token/*`     | Warp route implementations (HypERC20, HypERC20Collateral, HypNative)                     |

### TypeScript SDK (`typescript/sdk/src/`)

| Module                  | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `MultiProvider`         | Multi-chain provider management                  |
| `HyperlaneCore`         | Core contract interactions                       |
| `ChainMap<T>`           | Type-safe per-chain configuration                |
| `WarpCore`              | Warp route deployment and management             |
| `MultiProtocolProvider` | Unified interface across VMs (EVM, Cosmos, etc.) |

### Rust Agents (`rust/main/`)

| Agent       | Purpose                                    |
| ----------- | ------------------------------------------ |
| `relayer`   | Indexes messages, delivers to destinations |
| `validator` | Signs checkpoints for message verification |
| `scraper`   | Indexes chain data for analytics           |

**Chain Support** (`chains/`): `hyperlane-ethereum` (EVM), `hyperlane-cosmos`, `hyperlane-sealevel` (Solana/SVM), `hyperlane-fuel`

**Core Crates**: `hyperlane-core` (traits, message types), `hyperlane-base` (shared agent utilities)

## Key Concepts

| Term           | Definition                                                       |
| -------------- | ---------------------------------------------------------------- |
| **Domain**     | Unique identifier for each blockchain (not chain ID)             |
| **Message**    | Core struct: sender, recipient, origin/destination domains, body |
| **ISM**        | Interchain Security Module - pluggable verification logic        |
| **Hook**       | Post-dispatch processing (gas payments, merkle tree, etc.)       |
| **Checkpoint** | Validator-signed commitment to merkle root at index              |
| **Warp Route** | Token bridge deployment across chains                            |

### Gas Price Escalation

Automatic gas price increases for stuck transactions use the formula:

```
Max(Min(Max(Escalate(oldGasPrice), newEstimatedGasPrice), gasPriceCapMultiplier × newEstimatedGasPrice), oldGasPrice)
```

This prevents indefinite escalation while maintaining competitiveness and ensuring RBF compatibility. The `gasPriceCapMultiplier` is configurable per chain in `transactionOverrides` (default: 3).

## Configuration

### Chain Configs

- `rust/main/config/` - Agent chain configurations (mainnet3, testnet4)
- `typescript/sdk/src/consts/` - SDK chain metadata
- Registry: External package `@hyperlane-xyz/registry` contains canonical chain configs

### Environment Files

- `.registryrc` - Points to registry version/path
- `typescript/infra/config/` - Infrastructure deployment configs

## Code Review Guidelines

### Security-Critical Areas (require extra scrutiny)

| Area                  | Key Concerns                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `solidity/contracts/` | Reentrancy, access control, overflow, storage collisions, upgrade safety |
| `isms/`               | Message verification, multisig thresholds, validator sets                |
| `hooks/`              | Fee calculations, merkle tree integrity                                  |
| `rust/main/agents/`   | Key management, checkpoint signing, message validation                   |
| `typescript/infra/`   | Secrets exposure, RPC endpoints, deployment parameters                   |

### Common Patterns to Enforce

- Use `onlyOwner` or appropriate access modifiers on privileged functions
- Validate all external inputs at system boundaries
- Follow existing naming conventions and code organization
- Ensure backward compatibility for protocol upgrades
- Include tests for new functionality (especially edge cases)
- Gas efficiency for Solidity (avoid unnecessary storage writes)
- Use `ChainMap` for per-chain configurations in TypeScript

### What NOT to Flag

- Minor style issues handled by prettier/linters
- Existing intentional patterns (check git history if unsure)
- Theoretical issues without practical exploit paths

## Debugging & Operations

When debugging Hyperlane operational incidents (stuck messages, RPC failures, validator issues, gas problems, warp route imbalances), **always check `docs/ai-agents/operational-debugging.md` first**. It contains:

- **Grafana dashboard analysis** - Key panels for incident triage (Easy Dashboard, Validator Dashboards, Lander Dashboard, RPC Usage & Errors)
- **Progressive GCP log query strategies** - Efficiently analyze logs with minimal token usage
- **Error pattern recognition** - Gas estimation failures, validator delays, RPC issues
- **Hyperlane Explorer integration** - Find stuck messages before querying logs
- **Specific debugging workflows** - Queue length alerts, CouldNotFetchMetadata errors, RPC provider issues

**[Operations Runbook](https://www.notion.so/hyperlanexyz/Runbook-AI-Agent-24a6d35200d680229b38e8501164ca66)** contains manual procedures for:

- Agent deployment and redeployment
- RPC URL rotation when providers fail
- Validator operations and reorg recovery
- Manual message processing and retry
- Balance management and key funding
- Security incident response
- Lander (transaction submitter) configuration

## Running Local E2E Tests

```bash
# Full local environment with agents
cd rust/main && cargo run --release --bin run-locally

# Specific VM e2e
cargo test --release --package run-locally --features cosmos -- cosmos::test --nocapture
cargo test --release --package run-locally --features sealevel -- sealevel::test --nocapture
```

## Tips for Claude Code Sessions

1. **Run tests incrementally** - Don't run full test suite; run specific tests for changed code
2. **Check existing patterns** - Search codebase for similar implementations before writing new code
3. **Use TypeScript SDK types** - The SDK has comprehensive types; import from `@hyperlane-xyz/sdk`
4. **Solidity inheritance** - Many contracts inherit from base classes; check the hierarchy
5. **Config-driven** - Most deployments are config-driven; check `typescript/infra/config/` for examples
6. **Registry is external** - Chain metadata lives in `@hyperlane-xyz/registry`, not this repo
