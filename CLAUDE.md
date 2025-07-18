# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Hyperlane is an interchain messaging protocol monorepo built with a multi-language, multi-chain architecture. The repository contains Solidity contracts, TypeScript SDKs and tools, Rust agents, and support for multiple blockchain ecosystems (Ethereum, Cosmos, Solana, StarkNet).

## Development Commands

### Workspace Commands (from root)

```bash
# Build all packages
yarn build

# Run all tests
yarn test

# Run CI tests
yarn test:ci

# Lint all packages
yarn lint

# Format all packages
yarn prettier

# Clean all packages
yarn clean

# Run coverage across all packages
yarn coverage

# Update agent configurations
yarn agent-configs
```

### Solidity Development

```bash
# Build Solidity contracts
cd solidity && yarn build

# Run all Solidity tests (Hardhat + Foundry)
cd solidity && yarn test

# Run only Foundry tests
cd solidity && yarn test:forge

# Run only Hardhat tests
cd solidity && yarn test:hardhat

# Generate gas snapshots
cd solidity && yarn gas

# Run coverage
cd solidity && yarn coverage

# Run static analysis
cd solidity && yarn slither

# Generate storage layouts
cd solidity && yarn storage
```

### TypeScript Development

```bash
# Build TypeScript SDK
cd typescript/sdk && yarn build

# Run SDK tests
cd typescript/sdk && yarn test

# Build CLI
cd typescript/cli && yarn build

# Run CLI tests
cd typescript/cli && yarn test:ci

# Run E2E tests
cd typescript/cli && yarn test:e2e
```

### Rust Development

```bash
# Build Rust agents
cd rust/main && cargo build

# Run Rust tests
cd rust/main && cargo test

# Build Sealevel programs
cd rust/sealevel && cargo build

# Build Sealevel programs (shell script)
cd rust/sealevel/programs && ./build-programs.sh
```

## Architecture

### Core Components

**Contracts (Solidity)**

- `contracts/Mailbox.sol` - Core message passing contract
- `contracts/hooks/` - Post-dispatch hooks for custom logic
- `contracts/isms/` - Interchain Security Modules for message verification
- `contracts/token/` - Token bridge implementations (ERC20, ERC721, Native)
- `contracts/middleware/` - Higher-level protocols (ICA, IQS)

**TypeScript Packages**

- `typescript/sdk/` - Core SDK for interacting with Hyperlane
- `typescript/cli/` - Command-line interface for deployment and management
- `typescript/infra/` - Infrastructure and deployment tooling
- `typescript/utils/` - Shared utilities and helper functions
- `typescript/widgets/` - React components for UIs

**Rust Agents**

- `rust/main/agents/relayer/` - Message relaying agent
- `rust/main/agents/validator/` - Message validation agent
- `rust/main/agents/scraper/` - Chain indexing agent
- `rust/main/chains/` - Chain-specific implementations (Ethereum, Cosmos, Sealevel, StarkNet)

**Sealevel Programs (Solana)**

- `rust/sealevel/programs/mailbox/` - Solana mailbox program
- `rust/sealevel/programs/hyperlane-sealevel-token/` - Token bridge programs
- `rust/sealevel/programs/hyperlane-sealevel-igp/` - Interchain Gas Paymaster

### Key Directories

- `solidity/` - Smart contracts and related tooling
- `typescript/` - TypeScript packages and applications
- `rust/` - Rust agents and Sealevel programs
- `starknet/` - StarkNet contract bindings
- `vectors/` - Test vectors for cross-implementation testing

## Testing

### Running Tests

The monorepo uses a comprehensive testing strategy:

1. **Unit Tests** - Individual component testing
2. **Integration Tests** - Cross-component testing
3. **Hardhat Tests** - Ethereum contract testing
4. **Foundry Tests** - Gas-optimized Solidity testing
5. **E2E Tests** - End-to-end workflow testing

### Test Commands

```bash
# Run all tests
yarn test

# Run tests with coverage
yarn coverage

# Run CI tests (excludes fork tests)
yarn test:ci
```

### Environment Setup

Tests may require:

- Local blockchain nodes (Anvil, Hardhat)
- Environment variables for RPC endpoints
- Docker for agent testing

## Linting and Formatting

### Commands

```bash
# Lint all packages
yarn lint

# Format all packages
yarn prettier

# Lint specific package
cd typescript/sdk && yarn lint
cd solidity && yarn lint
```

### Configuration

- ESLint configuration in root and individual packages
- Prettier shared configuration
- Solhint for Solidity linting
- Rust clippy for Rust linting

## Code Standards

### TypeScript

- Strict TypeScript configuration
- Comprehensive type definitions
- Shared utility functions in `typescript/utils/`
- Consistent error handling patterns

### Solidity

- OpenZeppelin contracts for security
- Comprehensive test coverage
- Gas optimization focus
- Modular architecture with interfaces

### Rust

- Standard Rust patterns
- Comprehensive error types
- Async/await for I/O operations
- Structured logging

## Common Patterns

### Multi-Chain Support

- Chain-agnostic core interfaces
- Chain-specific implementations
- Unified addressing scheme
- Cross-chain message format

### Configuration Management

- YAML configuration files
- Environment-specific configs
- Validation schemas
- Type-safe configuration loading

### Agent Architecture

- Modular agent design
- Shared base functionality
- Chain-specific providers
- Metrics and monitoring

## Development Workflow

1. **Setup**: Install dependencies with `yarn install`
2. **Build**: Run `yarn build` to build all packages
3. **Test**: Run `yarn test` to verify changes
4. **Lint**: Run `yarn lint` to check code quality
5. **Format**: Run `yarn prettier` to format code

## Troubleshooting

### Common Issues

- **Build failures**: Check TypeScript versions and dependencies
- **Test failures**: Ensure local blockchain nodes are running
- **Lint errors**: Run `yarn prettier` to fix formatting issues
- **Package conflicts**: Clear node_modules and reinstall

### Environment Requirements

- Node.js v20+ (use nvm with `.nvmrc`)
- Foundry for Solidity development
- Rust toolchain for agent development
- Docker for containerized testing

## Useful Resources

- [Hyperlane Documentation](https://docs.hyperlane.xyz)
- [Foundry Book](https://book.getfoundry.sh)
- [Turbo Documentation](https://turbo.build/repo/docs)
