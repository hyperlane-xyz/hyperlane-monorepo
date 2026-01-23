# Rebalancer Test Harness

Manual test harness for the USDC warp route rebalancer using forked mainnet chains.

## Overview

This harness allows you to:

- Fork mainnet chains with the USDC CCTP warp route
- Replace ISMs with TestIsm for easy message verification
- Mock Circle CCTP contracts to bypass attestation
- Manipulate USDC balances to create imbalances
- Run the rebalancer and observe its behavior

## Prerequisites

- Anvil (from Foundry) installed
- Access to mainnet RPC endpoints for the chains you want to fork
- Node.js and pnpm

## Quick Start

```bash
# Terminal 1: Start the fork harness
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts setup

# Terminal 2: Check status
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts status

# Terminal 3: Create imbalance
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts imbalance \
  --chain ethereum --balance 100000

pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts imbalance \
  --chain arbitrum --balance 1000

# Terminal 4: Run rebalancer (use registry URL from setup output)
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts rebalance \
  --registry http://127.0.0.1:8535
```

## Commands

### `setup`

Fork chains and set up the test environment.

```bash
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts setup \
  --chains ethereum,arbitrum,base \
  --port 8545
```

Options:

- `--chains`: Comma-separated list of chains to fork (default: ethereum,arbitrum,base)
- `--port`: Starting port for Anvil nodes (default: 8545)

This command:

1. Forks each chain using Anvil
2. Deploys TestIsm and replaces the warp route ISM
3. Mocks Circle CCTP contracts using `anvil_setCode`
4. Sets up rebalancer permissions on MovableCollateralRouter
5. Starts an HTTP registry server with forked chain metadata
6. Writes a default rebalancer config file

### `status`

Show current USDC balances on warp routes.

```bash
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts status
```

### `imbalance`

Set USDC balance on a specific chain's warp route.

```bash
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts imbalance \
  --chain ethereum \
  --balance 50000
```

Options:

- `--chain`: Chain to modify (required)
- `--balance`: Balance in USDC (required)

This uses `anvil_setStorageAt` to directly set the ERC20 balance.

### `rebalance`

Run the rebalancer against forked chains.

```bash
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts rebalance \
  --registry http://127.0.0.1:8535 \
  --monitor-only
```

Options:

- `--registry`: HTTP registry URL from setup command (required)
- `--monitor-only`: Run without executing rebalance transactions
- `--config`: Path to rebalancer config file

### `relay`

Start a relayer for the forked chains.

```bash
pnpm --filter @hyperlane-xyz/cli ts-node src/tests/rebalancer/manual/harness.ts relay
```

### `cleanup`

Shows cleanup instructions.

## Supported Chains

The harness supports all chains from the `USDC/mainnet-cctp` warp route:

- ethereum
- arbitrum
- avalanche
- base
- optimism
- polygon
- unichain

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Test Harness                              │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │  Forked Chains  │    │   Mock Registry │                 │
│  │  (Anvil nodes)  │◄──►│  (HTTP server)  │                 │
│  └────────┬────────┘    └─────────────────┘                 │
│           │                                                  │
│  ┌────────▼────────┐    ┌─────────────────┐                 │
│  │   TestIsm       │    │  Mock Circle    │                 │
│  │   (deployed)    │    │  (bytecode)     │                 │
│  └────────┬────────┘    └────────┬────────┘                 │
│           │                      │                           │
│  ┌────────▼──────────────────────▼────────┐                 │
│  │         Warp Route Contracts           │                 │
│  └────────────────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

## How It Works

### ISM Replacement

The harness deploys a `TestIsm` contract that always returns `true` for `verify()`. This means messages don't need validator signatures to be delivered.

### CCTP Mocking

Circle's `MessageTransmitter` and `TokenMessenger` contracts are replaced with mock implementations using `anvil_setCode`. The mocks:

- Accept any attestation without verification
- Process messages immediately
- Mint/burn tokens directly

### Balance Manipulation

USDC balances are set directly using `anvil_setStorageAt`. This computes the storage slot for the ERC20 balances mapping and writes the value directly.

## Troubleshooting

### "Chain not running"

The Anvil node for that chain isn't running. Make sure `setup` is running.

### Balance not changing

Check that the balance slot is correct for that chain's USDC implementation. Different USDC versions may use different storage layouts.

### Rebalancer not detecting imbalance

Ensure the imbalance exceeds the strategy thresholds in the config file.
