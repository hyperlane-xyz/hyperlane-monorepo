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
import { RelayerConfig, RelayerService } from '@hyperlane-xyz/relayer/fs';

// Load config from file
const config = RelayerConfig.load('./config.yaml');

// Start the service
const service = new RelayerService(
  multiProvider,
  registry,
  { mode: 'daemon' },
  config,
);
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

## Package Exports

| Export                      | Description                                  | Browser-safe |
| --------------------------- | -------------------------------------------- | ------------ |
| `@hyperlane-xyz/relayer`    | Core relayer, metadata builders, schemas     | Yes          |
| `@hyperlane-xyz/relayer/fs` | RelayerService, RelayerConfig (file loading) | No (Node.js) |

## Architecture

```
typescript/relayer/
├── src/
│   ├── core/
│   │   └── HyperlaneRelayer.ts   # Core relaying logic (browser-safe)
│   ├── metadata/                  # ISM metadata builders (browser-safe)
│   ├── config/
│   │   └── schema.ts             # Config schema (browser-safe)
│   ├── fs/                        # Node.js specific
│   │   ├── RelayerService.ts     # Service with file cache + signals
│   │   ├── RelayerConfig.ts      # Config file loading
│   │   └── service.ts            # Daemon entry point
│   └── index.ts                  # Browser-safe exports
```

## License

Apache-2.0
