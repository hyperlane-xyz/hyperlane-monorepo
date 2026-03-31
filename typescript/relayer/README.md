# @hyperlane-xyz/relayer

Hyperlane Message Relayer Service - relays interchain messages across Hyperlane-connected chains.

## Installation

```bash
# From monorepo root
pnpm install

# Build the package
pnpm --filter @hyperlane-xyz/relayer build
```

## Usage

### Browser / Library Usage

The main export is browser-safe and can be used in any JavaScript environment:

```typescript
import { HyperlaneRelayer } from '@hyperlane-xyz/relayer';
import { HyperlaneCore } from '@hyperlane-xyz/sdk';

// Direct usage (browser-safe)
const addresses = /* chain -> contract addresses map */;
const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);
const relayer = new HyperlaneRelayer({ core });

// Relay a single message
await relayer.relayMessage(dispatchTx);

// Or start continuous relaying
relayer.start();
```

### Node.js Daemon Mode

For Node.js environments with filesystem access, use the `/fs` export:

```typescript
import { RelayerService, loadConfig } from '@hyperlane-xyz/relayer/fs';

// Load config from file
const relayerConfig = loadConfig('./config.yaml');

// Start the service
const service = await RelayerService.create(multiProvider, registry, {
  enableMetrics: true,
  relayerConfig,
});
await service.start();
```

### CLI Integration

The CLI uses this package for relaying:

```bash
hyperlane relayer --chains ethereum,arbitrum
```

### Standalone Daemon (K8s Service)

Run as a continuous service:

```bash
export HYP_KEY=your_private_key
export RELAYER_CHAINS=ethereum,arbitrum
export RELAYER_CACHE_FILE=/data/relayer-cache.json

node dist/fs/service.js
```

## Configuration

### Environment Variables

| Variable              | Description                              | Required | Default |
| --------------------- | ---------------------------------------- | -------- | ------- |
| `HYP_KEY`             | Private key for signing transactions     | Yes      | -       |
| `RELAYER_CONFIG_FILE` | Path to YAML config file                 | No       | -       |
| `RELAYER_CHAINS`      | Comma-separated chain list               | No       | -       |
| `RELAYER_CACHE_FILE`  | Path to cache file for persistence       | No       | -       |
| `LOG_LEVEL`           | Logging level (debug, info, warn, error) | No       | info    |
| `PROMETHEUS_ENABLED`  | Enable Prometheus metrics server         | No       | true    |
| `PROMETHEUS_PORT`     | Port for metrics endpoint                | No       | 9090    |

### YAML Configuration

```yaml
chains:
  - ethereum
  - arbitrum
  - optimism
whitelist:
  ethereum:
    - '0x1234...'
  arbitrum:
    - '0x5678...'
retryTimeout: 1000
cacheFile: ./relayer-cache.json
```

## Package Exports

| Export                      | Description                               | Browser-safe |
| --------------------------- | ----------------------------------------- | ------------ |
| `@hyperlane-xyz/relayer`    | Core relayer, metadata builders, schemas  | Yes          |
| `@hyperlane-xyz/relayer/fs` | RelayerService, loadConfig (file loading) | No (Node.js) |

## Prometheus Metrics

The relayer exposes metrics at `http://localhost:9090/metrics` (configurable via `PROMETHEUS_PORT`).

| Metric                                               | Type      | Description                                                          |
| ---------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| `hyperlane_relayer_messages_total`                   | Counter   | Messages processed (labels: origin_chain, destination_chain, status) |
| `hyperlane_relayer_retries_total`                    | Counter   | Retry attempts                                                       |
| `hyperlane_relayer_backlog_size`                     | Gauge     | Current message backlog                                              |
| `hyperlane_relayer_relay_duration_seconds`           | Histogram | Time to relay messages                                               |
| `hyperlane_relayer_messages_skipped_total`           | Counter   | Messages filtered by whitelist                                       |
| `hyperlane_relayer_messages_already_delivered_total` | Counter   | Messages already delivered                                           |

## Architecture

```
typescript/relayer/
├── src/
│   ├── index.ts                  # Browser-safe exports
│   ├── core/
│   │   ├── HyperlaneRelayer.ts   # Core relaying logic (browser-safe)
│   │   ├── cache.ts              # Cache schema + types
│   │   ├── events.ts             # Relayer event types
│   │   └── whitelist.ts          # Whitelist helper
│   ├── metadata/                  # ISM metadata builders (browser-safe)
│   ├── config/
│   │   └── schema.ts             # Config schema (browser-safe)
│   └── fs/                        # Node.js specific
│       ├── index.ts              # Node.js exports
│       ├── RelayerService.ts     # Service with file cache + signals
│       ├── RelayerConfig.ts      # Config file loading helper
│       ├── service.ts            # Daemon entry point
│       ├── relayerMetrics.ts     # Prometheus metric definitions
│       └── metricsServer.ts      # HTTP server for /metrics
```

## License

Apache-2.0
