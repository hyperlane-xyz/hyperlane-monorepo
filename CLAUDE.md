# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the Hyperlane monorepo - a fork by Dymension containing modifications for interchain messaging protocol that allows applications to communicate between blockchains. Key modifications include:

- **Memo support**: Extended HypERC20, HypNative, and HypERC20Collateral contracts to include memo functionality
- **Kaspa integration**: Custom Rust library for Kaspa blockchain integration
- **Dymension-specific tests**: Test suites for Ethereum Hub, Kaspa Hub, and Solana native/synth memo functionality

## Common Development Commands

### Building and Installing

```bash
# Install dependencies (from root)
yarn install

# Build all packages
yarn build

# Clean build artifacts
yarn clean

# Lint all packages
yarn lint

# Run prettier
yarn prettier
```

### TypeScript CLI Development

```bash
# Build and install CLI locally
cd typescript/cli
yarn build
yarn bundle
npm install -g

# Development mode with watch
yarn dev

# Run CLI
hyperlane --version
```

### Solidity Development

```bash
cd solidity

# Compile contracts
yarn hardhat-esm compile

# Run tests
yarn test:hardhat  # Hardhat tests
yarn test:forge    # Foundry tests
yarn test          # Run all tests

# Run specific Foundry test
yarn test:forge --match-contract HypERC20MemoTest
yarn test:forge --match-contract HypERC20CollateralMemoTest
yarn test:forge --match-contract HypNativeMemoTest

# Coverage
yarn coverage

# Gas snapshots
yarn gas
```

### Rust Development

```bash
# Build agents
cd rust/main
cargo build --release --bin relayer
cargo build --release --bin validator
cargo build --release --bin scraper

# Run tests
cargo test
cargo test --test functional  # Functional tests only

# Build Kaspa library
cd dymension/libs/kaspa
cargo build
cargo test
```

### Running Local Tests

```bash
# Ethereum Hub Test (DYM)
cd dymension/tests/ethereum_hub_test_dym
bash commands.sh

# Ethereum Hub Test (ERC20)
cd dymension/tests/ethereum_hub_test_erc20
bash commands.sh

# Kaspa Hub Test
cd dymension/tests/kaspa_hub_test_kas
bash commands.sh

# Solana Tests
cd dymension/tests/solana_native_memo_test
bash commands.sh
```

## Architecture Overview

### Monorepo Structure

- **`/solidity`**: Core Hyperlane smart contracts with Dymension's memo extensions
- **`/typescript`**: TypeScript packages including SDK, CLI, and utilities
- **`/rust`**: Rust implementation of agents (relayer, validator, scraper)
- **`/dymension`**: Dymension-specific code including:
  - `/libs/kaspa`: Kaspa blockchain integration library
  - `/tests`: Integration test suites for various chain configurations

### Key Modifications

1. **Memo Support in Token Transfers**:
   - `HypERC20Memo`: Synthetic tokens with memo support
   - `HypNativeMemo`: Native tokens with memo support
   - `HypERC20CollateralMemo`: Collateral tokens with memo support
   - Added `transferRemoteMemo()` function to include arbitrary data in transfers

2. **Kaspa Integration**:
   - Custom Rust library for Kaspa blockchain support
   - Uses WRPC for client connections
   - Implements Hyperlane protocol for Kaspa transactions

3. **Test Infrastructure**:
   - Local chain setup scripts (Anvil for Ethereum, custom for Dymension/Kaspa)
   - Agent configuration files for relayers and validators
   - End-to-end transfer testing with memo support

### Development Workflow

1. **For Contract Changes**:
   - Modify contracts in `/solidity/contracts`
   - Add/update tests in `/solidity/test`
   - Run `yarn test:forge` to verify changes
   - Update TypeScript bindings if needed

2. **For Agent Changes**:
   - Modify Rust code in `/rust/main`
   - Build with `cargo build --release`
   - Test with local chains using scripts in `/dymension/tests`

3. **For CLI Changes**:
   - Modify TypeScript code in `/typescript/cli`
   - Rebuild and reinstall: `yarn clean && yarn build && yarn bundle && npm install -g`
   - Test with local deployments

## Important Notes

- Always run `yarn clean` before rebuilding to ensure fresh builds
- The CLI depends on the SDK, so build SDK first when making changes
- Solana development requires multiple versions (v1.14.20 for building, v2 for local node, v1.18.18 for deployment)
- When running local tests, ensure proper funding of relayer addresses
- Kaspa clients must connect via WRPC to a node with GRPC server and UTXO index