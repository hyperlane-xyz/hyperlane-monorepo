# @hyperlane-xyz/rebalancer

Hyperlane Warp Route Collateral Rebalancer Service - maintains optimal collateral distribution across chains for Hyperlane warp routes.

## Overview

The rebalancer monitors collateral balances across warp route deployments and automatically transfers tokens between chains to maintain configured target balances. It supports both manual one-off rebalances and continuous daemon mode for production deployments.

## Features

- **Multi-Protocol Support**: Protocol-agnostic design supporting EVM chains (Cosmos, Sealevel, etc. when movable collateral contracts available)
- **Flexible Strategies**: Weighted, minimum-amount, and collateral-deficit rebalancing strategies
- **Composite Strategies**: Combine multiple strategies with different bridges for layered rebalancing
- **Inflight Tracking**: Monitors pending rebalances to prevent duplicate transfers
- **Safety Features**: Inflight guards, semaphores, and comprehensive validation
- **Observability**: Built-in Prometheus metrics and structured logging
- **Dual Mode**: Manual CLI execution or continuous daemon service
- **Bridge Support**: Integration with Hyperlane warp routes and external bridges

## Installation

```bash
# From monorepo root
pnpm install

# Build the package
pnpm --filter @hyperlane-xyz/rebalancer build
```

## Usage

### Manual Rebalancing (CLI)

Execute a one-off rebalance using the CLI:

```bash
# Via CLI package
pnpm --filter @hyperlane-xyz/cli hyperlane warp rebalancer \
  --config /path/to/rebalancer-config.yaml \
  --manual \
  --origin ethereum \
  --destination arbitrum \
  --amount 1000
```

### Daemon Mode (Service)

Run as a continuous service (typically in K8s):

```bash
# Set environment variables
export REBALANCER_CONFIG_FILE=/path/to/rebalancer-config.yaml
export HYP_KEY=your_private_key
export COINGECKO_API_KEY=your_api_key

# Start the service
pnpm --filter @hyperlane-xyz/rebalancer start

# Or with direct node
node dist/service.js
```

### Programmatic Usage

```typescript
import { RebalancerService } from '@hyperlane-xyz/rebalancer';

const service = new RebalancerService(
  multiProvider,
  multiProtocolProvider,
  registry,
  rebalancerConfig,
  {
    mode: 'daemon',
    checkFrequency: 60_000,
    withMetrics: true,
    coingeckoApiKey: process.env.COINGECKO_API_KEY,
    logger: console,
  },
);

// Start daemon
await service.start();

// Or execute manual rebalance
await service.executeManual({
  origin: 'ethereum',
  destination: 'arbitrum',
  amount: '1000',
});
```

## Configuration

The rebalancer uses a YAML configuration file with a `warpRouteId` and `strategy` field.

### Basic Example (Single Strategy)

```yaml
warpRouteId: ETH/ethereum-arbitrum-optimism
strategy:
  rebalanceStrategy: weighted
  chains:
    ethereum:
      weight: 60
      tolerance: 5
      bridge: '0x1234...abcd'
    arbitrum:
      weight: 20
      tolerance: 5
      bridge: '0x5678...efgh'
```

### Composite Strategy (v1.0.0+)

The `strategy` field accepts an array of strategies for composite rebalancing. Strategies are evaluated in order - the first strategy that produces routes is used.

```yaml
warpRouteId: USDC/base-ethereum-arbitrum
strategy:
  # First: CollateralDeficitStrategy with fast bridges for reactive rebalancing
  - rebalanceStrategy: collateralDeficit
    chains:
      base:
        buffer: 0
        bridge: '0x584244d02b0fBf9054A5D5C9e9cE9A2E8adA0e28'
      ethereum:
        buffer: 0
        bridge: '0xEE4a09db2C25592C04b8b342CB89f9a7f5E20BD2'

  # Second: MinAmountStrategy with standard bridges for baseline floors
  - rebalanceStrategy: minAmount
    chains:
      base:
        minAmount:
          min: 0.1
          target: 0.11
          type: 'absolute'
        bridgeLockTime: 1800
        bridge: '0x33e94B6D2ae697c16a750dB7c3d9443622C4405a'
      ethereum:
        minAmount:
          min: 0.1
          target: 0.11
          type: 'absolute'
        bridgeLockTime: 1800
        bridge: '0x8c8D831E1e879604b4B304a2c951B8AEe3aB3a23'
```

> **Note**: When using `collateralDeficit` in a composite strategy, it must be the first strategy in the array.

### Strategy Types

| Strategy            | Use Case                                               | Chain Config Fields              |
| ------------------- | ------------------------------------------------------ | -------------------------------- |
| `weighted`          | Maintain percentage distribution across chains         | `weight`, `tolerance`            |
| `minAmount`         | Trigger rebalance when balance falls below floor       | `minAmount: {min, target, type}` |
| `collateralDeficit` | React to bridged supply gaps (synthetic vs collateral) | `buffer`                         |

#### Weighted Strategy

Maintains target weight percentages across chains. Rebalances when deviation exceeds tolerance.

```yaml
strategy:
  rebalanceStrategy: weighted
  chains:
    ethereum:
      weight: 60 # Target 60% of total supply
      tolerance: 5 # Rebalance if >5% deviation
      bridge: '0x...'
```

#### MinAmount Strategy

Triggers rebalance when a chain's balance falls below the minimum threshold.

```yaml
strategy:
  rebalanceStrategy: minAmount
  chains:
    ethereum:
      minAmount:
        min: 100 # Trigger rebalance below this
        target: 110 # Rebalance up to this amount
        type: 'absolute' # or 'relative' (percentage of total)
      bridge: '0x...'
```

#### CollateralDeficit Strategy

Monitors bridged (synthetic) supply vs collateral and rebalances to cover deficits.

```yaml
strategy:
  rebalanceStrategy: collateralDeficit
  chains:
    ethereum:
      buffer: 1000 # Extra collateral buffer above deficit
      bridge: '0x...'
```

### Chain Config Reference

| Field                     | Type             | Required | Description                                                    |
| ------------------------- | ---------------- | -------- | -------------------------------------------------------------- |
| `bridge`                  | `0x...` address  | Yes      | Bridge contract address for this chain                         |
| `bridgeLockTime`          | number (seconds) | No       | Expected bridge transfer duration (used for inflight tracking) |
| `bridgeMinAcceptedAmount` | number           | No       | Skip routes with amounts below this threshold                  |
| `override`                | object           | No       | Per-destination bridge overrides (see below)                   |

#### Per-Destination Overrides

Use `override` to specify different bridge configs for specific destination chains:

```yaml
strategy:
  rebalanceStrategy: minAmount
  chains:
    ethereum:
      minAmount: { min: 100, target: 110, type: 'absolute' }
      bridge: '0xDefaultBridge...'
      override:
        arbitrum:
          bridge: '0xFastArbitrumBridge...'
          bridgeLockTime: 600
        optimism:
          bridge: '0xOptimismBridge...'
```

## Architecture

### Package Structure

```
typescript/rebalancer/
├── src/
│   ├── core/
│   │   ├── RebalancerService.ts    # Main orchestrator
│   │   ├── Rebalancer.ts           # Core rebalancing logic
│   │   ├── WithInflightGuard.ts    # Concurrency protection
│   │   └── WithSemaphore.ts        # Semaphore wrapper
│   ├── strategy/
│   │   ├── WeightedStrategy.ts          # Weighted distribution
│   │   ├── MinAmountStrategy.ts         # Minimum threshold strategy
│   │   ├── CollateralDeficitStrategy.ts # Bridged supply deficit strategy
│   │   └── CompositeStrategy.ts         # Combines multiple strategies
│   ├── monitor/
│   │   └── Monitor.ts              # Balance monitoring
│   ├── metrics/
│   │   └── Metrics.ts              # Prometheus metrics collection
│   ├── config/
│   │   └── RebalancerConfig.ts     # Config loading/validation
│   ├── utils/
│   ├── interfaces/
│   ├── service.ts                  # Service entry point
│   └── index.ts                    # Public API
```

### Dependencies

- `@hyperlane-xyz/sdk`: Core SDK with MultiProvider and WarpCore
- `@hyperlane-xyz/provider-sdk`: Protocol-agnostic provider abstractions
- `@hyperlane-xyz/utils`: Shared utilities and types
- `prom-client`: Prometheus metrics
- `pino`: Structured logging

## Development

### Running Tests

```bash
pnpm --filter @hyperlane-xyz/rebalancer test
```

### Local Development

```bash
# Watch mode
pnpm --filter @hyperlane-xyz/rebalancer dev

# Start with test config
HYP_KEY=your_test_key \
REBALANCER_CONFIG_FILE=./test-config.yaml \
pnpm --filter @hyperlane-xyz/rebalancer start:dev
```

## Migration from CLI

This package replaces the rebalancer functionality previously embedded in `@hyperlane-xyz/cli`. Key changes:

1. **Dedicated Package**: Now a standalone service package
2. **Direct Entry Point**: K8s deployments use `service.ts` directly (no CLI wrapper)
3. **Metrics Included**: Prometheus metrics stay with the service
4. **Protocol-Agnostic**: Aligned with multi-VM architecture
5. **Dual Mode Support**: Single codebase for both manual and daemon modes

## License

Apache-2.0
