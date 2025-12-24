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

### CLI Integration

The CLI uses this package for relaying:

```bash
hyperlane relayer --chains ethereum,arbitrum
```

### Daemon Mode (K8s Service)

Run as a continuous service:

```bash
export HYP_KEY=your_private_key
export RELAYER_CHAINS=ethereum,arbitrum
export RELAYER_CACHE_FILE=/data/relayer-cache.json

node dist/service.js
```

### Programmatic Usage

```typescript
import { HyperlaneRelayer, RelayerService } from '@hyperlane-xyz/relayer';
import { HyperlaneCore } from '@hyperlane-xyz/sdk';

// Direct usage
const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);
const relayer = new HyperlaneRelayer({ core });
relayer.start();

// Service wrapper
const service = new RelayerService(multiProvider, registry, { mode: 'daemon' });
await service.start();
```

## Configuration

### Environment Variables

| Variable              | Description                              | Required |
| --------------------- | ---------------------------------------- | -------- |
| `HYP_KEY`             | Private key for signing transactions     | Yes      |
| `RELAYER_CONFIG_FILE` | Path to YAML config file                 | No       |
| `RELAYER_CHAINS`      | Comma-separated chain list               | No       |
| `RELAYER_CACHE_FILE`  | Path to cache file for persistence       | No       |
| `LOG_LEVEL`           | Logging level (debug, info, warn, error) | No       |

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

## Architecture

```
typescript/relayer/
├── src/
│   ├── core/
│   │   ├── HyperlaneRelayer.ts   # Core relaying logic
│   │   └── RelayerService.ts     # Service orchestrator
│   ├── config/
│   │   └── RelayerConfig.ts      # Config loading/validation
│   ├── service.ts                # Daemon entry point
│   └── index.ts                  # Public API
```

## License

Apache-2.0
