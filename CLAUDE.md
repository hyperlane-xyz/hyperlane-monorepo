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
yarn build

# Run all tests
yarn test

# Lint and format
yarn lint && yarn prettier

# Solidity tests (both Hardhat and Forge)
yarn --cwd solidity test

# TypeScript SDK tests
yarn --cwd typescript/sdk test

# Rust tests
cd rust/main && cargo test

# CLI e2e tests (useful for testing warp routes, core deployments)
yarn --cwd typescript/cli test:ethereum:e2e
```

### Before Committing

```bash
yarn lint          # Must pass
yarn prettier      # Auto-formats code
yarn test          # Run relevant tests
yarn changeset     # Add changeset if modifying published packages
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
yarn build                              # Build all packages (uses Turbo)
yarn --cwd solidity build               # Build Solidity contracts
yarn --cwd typescript/sdk build         # Build TypeScript SDK
cd rust/main && cargo build             # Build Rust agents
```

### Testing

```bash
# Solidity
yarn --cwd solidity test                # Both Hardhat and Forge tests
yarn --cwd solidity test:hardhat        # Hardhat only
yarn --cwd solidity test:forge          # Forge only
forge test -vvv --decode-internal       # Detailed Forge output

# TypeScript
yarn --cwd typescript/sdk test          # SDK tests
yarn --cwd typescript/sdk test:unit     # Unit tests only
yarn --cwd typescript/cli test:ethereum:e2e  # CLI e2e tests

# Rust
cd rust/main && cargo test              # All Rust tests
cd rust/main && cargo test <test_name>  # Single test

# E2E (runs local chains + agents)
cd rust/main && cargo run --release --bin run-locally
```

### Linting & Formatting

```bash
yarn lint                               # Lint all packages
yarn prettier                           # Format all packages
yarn --cwd solidity lint                # Solidity linting (solhint)
cd rust/main && cargo clippy            # Rust linting
cd rust/main && cargo fmt               # Rust formatting
```

### Solidity-Specific

```bash
yarn --cwd solidity hardhat-esm compile # Compile contracts
yarn --cwd solidity fixtures            # Generate test fixtures (required before forge tests)
yarn --cwd solidity gas                 # Generate gas snapshots
yarn --cwd solidity coverage            # Coverage report
yarn --cwd solidity storage             # Storage layout analysis
forge test --match-test <pattern>       # Run specific Forge tests
```

### CLI Development

```bash
# Install CLI globally from local build
yarn --cwd typescript/cli build && npm link

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

| Module          | Purpose                              |
| --------------- | ------------------------------------ |
| `MultiProvider` | Multi-chain provider management      |
| `HyperlaneCore` | Core contract interactions           |
| `ChainMap<T>`   | Type-safe per-chain configuration    |
| `WarpCore`      | Warp route deployment and management |

### Rust Agents (`rust/main/`)

| Agent       | Purpose                                    |
| ----------- | ------------------------------------------ |
| `relayer`   | Indexes messages, delivers to destinations |
| `validator` | Signs checkpoints for message verification |
| `scraper`   | Indexes chain data for analytics           |

## Key Concepts

| Term           | Definition                                                       |
| -------------- | ---------------------------------------------------------------- |
| **Domain**     | Unique identifier for each blockchain (not chain ID)             |
| **Message**    | Core struct: sender, recipient, origin/destination domains, body |
| **ISM**        | Interchain Security Module - pluggable verification logic        |
| **Hook**       | Post-dispatch processing (gas payments, merkle tree, etc.)       |
| **Checkpoint** | Validator-signed commitment to merkle root at index              |
| **Warp Route** | Token bridge deployment across chains                            |

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

For operational incidents (stuck messages, RPC failures, validator issues), see:

- `docs/ai-agents/operational-debugging.md` - AI-powered debugging workflows
- [Operations Runbook](https://www.notion.so/hyperlanexyz/Runbook-AI-Agent-24a6d35200d680229b38e8501164ca66) - Manual procedures

## Common Tasks

### Adding a New Chain

1. Add chain metadata to registry
2. Update `rust/main/config/` with agent config
3. Deploy contracts via CLI or infra scripts
4. Add to SDK chain constants if needed

### Creating a Warp Route

```bash
hyperlane warp init                    # Generate config
hyperlane warp deploy --config ...     # Deploy route
hyperlane warp read --chain ... --address ...  # Verify deployment
```

### Running Local E2E Tests

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
