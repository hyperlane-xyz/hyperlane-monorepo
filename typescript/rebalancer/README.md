# @hyperlane-xyz/rebalancer

Hyperlane Warp Route Collateral Rebalancer Service - maintains optimal collateral distribution across chains for Hyperlane warp routes.

## Overview

The rebalancer monitors collateral balances across warp route deployments and automatically transfers tokens between chains to maintain configured target balances. It supports both manual one-off rebalances and continuous daemon mode for production deployments.

## Features

- **Multi-Protocol Support**: Protocol-agnostic design supporting EVM chains (Cosmos, Sealevel, etc. when movable collateral contracts available)
- **Flexible Strategies**: Weighted and minimum-amount rebalancing strategies
- **Safety Features**: Inflight guards, semaphores, and comprehensive validation
- **Observability**: Built-in Prometheus metrics and structured logging
- **Dual Mode**: Manual CLI execution or continuous daemon service
- **Bridge Support**: Integration with Portal, Hyperlane, and other bridge providers

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

The rebalancer uses a YAML configuration file. See example:

```yaml
warpRouteId: ETH/ethereum-arbitrum-optimism
strategy:
  rebalanceStrategy: weighted
  chains:
    ethereum:
      weight: 60
      bridge: hyperlane
    arbitrum:
      weight: 20
      bridge: hyperlane
    optimism:
      weight: 20
      bridge: portal
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
│   │   ├── WeightedStrategy.ts     # Weighted distribution
│   │   └── MinAmountStrategy.ts    # Minimum threshold strategy
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
