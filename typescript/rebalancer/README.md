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
yarn install

# Build the package
yarn workspace @hyperlane-xyz/rebalancer build
```

## Usage

### Manual Rebalancing (CLI)

Execute a one-off rebalance using the CLI:

```bash
# Via CLI package
yarn workspace @hyperlane-xyz/cli hyperlane warp rebalancer \
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
yarn workspace @hyperlane-xyz/rebalancer start

# Or with direct node
node dist/service.js
```

### Programmatic Usage

```typescript
import { RebalancerService } from '@hyperlane-xyz/rebalancer';

const service = new RebalancerService(multiProvider, rebalancerConfig, {
  mode: 'daemon',
  checkFrequency: 60_000,
  withMetrics: true,
  signer: privateKey,
  logger: console,
});

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
warpRouteId: ETH
strategy:
  type: weighted
  weightsConfig:
    - chain: ethereum
      weight: 60
    - chain: arbitrum
      weight: 20
    - chain: optimism
      weight: 20

chains:
  ethereum:
    minBalance: '1000000000000000000' # 1 ETH
    desiredBalance: '10000000000000000000' # 10 ETH
    bridgeName: hyperlane
  arbitrum:
    minBalance: '500000000000000000' # 0.5 ETH
    desiredBalance: '5000000000000000000' # 5 ETH
    bridgeName: hyperlane
  optimism:
    minBalance: '500000000000000000'
    desiredBalance: '5000000000000000000'
    bridgeName: portal
    portalConfiguration:
      originCircleDomain: 0
      destinationCircleDomain: 6
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
│   │   ├── MinAmountStrategy.ts    # Minimum threshold strategy
│   │   └── validators/             # Bridge-specific validation
│   ├── monitor/
│   │   ├── Monitor.ts              # Balance monitoring
│   │   └── events.ts               # Event types
│   ├── metrics/
│   │   ├── PrometheusMetrics.ts    # Metrics collection
│   │   └── server.ts               # HTTP metrics endpoint
│   ├── config/
│   │   ├── RebalancerConfig.ts     # Config loading/validation
│   │   └── schemas.ts              # Zod schemas
│   ├── utils/
│   │   ├── bridgeUtils.ts          # Bridge helpers
│   │   ├── balanceUtils.ts         # Balance calculations
│   │   └── tokenUtils.ts           # Token operations
│   ├── interfaces/
│   │   └── IRebalancerAdapter.ts   # Protocol adapter interface
│   ├── service.ts                  # Service entry point
│   └── index.ts                    # Public API
```

### Dependencies

- `@hyperlane-xyz/sdk`: Core SDK with MultiProvider and WarpCore
- `@hyperlane-xyz/provider-sdk`: Protocol-agnostic provider abstractions
- `@hyperlane-xyz/utils`: Shared utilities and types
- `prom-client`: Prometheus metrics
- `express`: HTTP server for metrics endpoint
- `pino`: Structured logging

### Multi-Protocol Design

The rebalancer is designed to be protocol-agnostic:

- Uses `IRebalancerAdapter` interface for protocol-specific operations
- Currently implements `EvmMovableCollateralAdapter` for EVM chains
- Ready to support AltVM chains when movable collateral contracts are available
- Leverages `MultiProtocolProvider` for chain interactions

## Deployment

### Kubernetes

The service is deployed as a StatefulSet in production:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: rebalancer
spec:
  serviceName: rebalancer
  replicas: 1
  template:
    spec:
      containers:
        - name: rebalancer
          image: gcr.io/abacus-labs-dev/hyperlane-monorepo:latest
          command: ['node']
          args: ['typescript/rebalancer/dist/service.js']
          env:
            - name: REBALANCER_CONFIG_FILE
              value: /config/rebalancer-config.yaml
            - name: HYP_KEY
              valueFrom:
                secretKeyRef:
                  name: rebalancer-secrets
                  key: private-key
          volumeMounts:
            - name: config
              mountPath: /config
```

### Monitoring

Prometheus metrics exposed on port 9090:

- `hyperlane_rebalancer_balance_total`: Current balances per chain
- `hyperlane_rebalancer_rebalance_attempts_total`: Rebalance attempt counter
- `hyperlane_rebalancer_rebalance_success_total`: Successful rebalances
- `hyperlane_rebalancer_rebalance_failure_total`: Failed rebalances
- `hyperlane_rebalancer_transaction_duration_seconds`: Transaction duration histogram

## Development

### Running Tests

```bash
yarn workspace @hyperlane-xyz/rebalancer test
```

### Local Development

```bash
# Watch mode
yarn workspace @hyperlane-xyz/rebalancer dev

# Start with test config
HYP_KEY=your_test_key \
REBALANCER_CONFIG_FILE=./test-config.yaml \
yarn workspace @hyperlane-xyz/rebalancer start:dev
```

### Debugging

Enable debug logging:

```bash
export LOG_LEVEL=debug
yarn workspace @hyperlane-xyz/rebalancer start
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
