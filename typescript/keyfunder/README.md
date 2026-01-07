# @hyperlane-xyz/keyfunder

Standalone service for funding Hyperlane agent keys with native tokens across multiple chains.

## Overview

The KeyFunder service:

- Funds agent keys (relayers, kathy, rebalancer) to maintain desired balances
- Claims accumulated fees from InterchainGasPaymaster (IGP) contracts
- Sweeps excess funds from the funder wallet to a safe address

## Configuration

The service reads configuration from a YAML file. The file path is specified via the `KEYFUNDER_CONFIG_FILE` environment variable.

### Example Configuration

```yaml
version: '1'

# Roles define WHO gets funded (address defined once, reused across chains)
roles:
  hyperlane-relayer:
    address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5'
  hyperlane-kathy:
    address: '0x5fb02f40f56d15f0442a39d11a23f73747095b20'
  hyperlane-rebalancer:
    address: '0xdef456...'

# Chains define HOW MUCH each role gets (balances reference role names)
chains:
  ethereum:
    balances:
      hyperlane-relayer: '0.5'
      hyperlane-kathy: '0.4'
    igp:
      address: '0x6cA0B6D43F8e45C82e57eC5a5F2Bce4bF2b6F1f7'
      claimThreshold: '0.2'
    sweep:
      enabled: true
      address: '0x478be6076f31E9666123B9721D0B6631baD944AF'
      threshold: '0.3'
      targetMultiplier: 1.5
      triggerMultiplier: 2.0
  arbitrum:
    balances:
      hyperlane-relayer: '0.1'
    igp:
      # address is optional - falls back to registry's interchainGasPaymaster
      claimThreshold: '0.1'

metrics:
  jobName: 'keyfunder-mainnet3'
  labels:
    environment: 'mainnet3'
chainsToSkip: []
```

### Configuration Options

| Field                                    | Description                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `version`                                | Config version, must be "1"                                                                      |
| `roles`                                  | Role definitions (address per role)                                                              |
| `roles.<role>.address`                   | Ethereum address for this role                                                                   |
| `chains`                                 | Per-chain configuration                                                                          |
| `chains.<chain>.balances`                | Map of role name to desired balance                                                              |
| `chains.<chain>.balances.<role>`         | Target balance decimal string (e.g., "0.5" ETH; up to 18 decimals)                               |
| `chains.<chain>.igp`                     | IGP claim configuration                                                                          |
| `chains.<chain>.igp.address`             | IGP contract address (optional; falls back to registry's `interchainGasPaymaster` if omitted)    |
| `chains.<chain>.igp.claimThreshold`      | Minimum IGP balance before claiming (decimal string; up to 18 decimals)                          |
| `chains.<chain>.sweep`                   | Sweep excess funds configuration                                                                 |
| `chains.<chain>.sweep.enabled`           | Enable sweep functionality                                                                       |
| `chains.<chain>.sweep.address`           | Address to sweep funds to (required when enabled)                                                |
| `chains.<chain>.sweep.threshold`         | Base threshold for sweep calculations (required when enabled; decimal string; up to 18 decimals) |
| `chains.<chain>.sweep.targetMultiplier`  | Multiplier for target balance (default: 1.5; 2 decimal precision, floored)                       |
| `chains.<chain>.sweep.triggerMultiplier` | Multiplier for trigger threshold (default: 2.0; 2 decimal precision, floored)                    |
| `metrics.jobName`                        | Job name for metrics                                                                             |
| `metrics.labels`                         | Additional labels for metrics                                                                    |
| `chainsToSkip`                           | Array of chain names to skip                                                                     |

### Precision Notes

- **Balance strings**: Support up to 18 decimal places (standard ETH precision). Must include leading digit (e.g., `"0.5"` not `".5"`).
- **Multipliers**: Calculated with 2 decimal precision using floor (e.g., `1.555` is treated as `1.55`, not `1.56`).

## Environment Variables

| Variable                  | Description                                                                                                                                  | Required |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `KEYFUNDER_CONFIG_FILE`   | Path to config YAML file                                                                                                                     | Yes      |
| `HYP_KEY`                 | Private key for funding wallet                                                                                                               | Yes      |
| `RPC_URL_<CHAIN>`         | RPC URL per chain (e.g., `RPC_URL_ETHEREUM`, `RPC_URL_ARBITRUM`). Falls back to registry defaults if not set.                                | No       |
| `REGISTRY_URI`            | Hyperlane registry URI (default: GitHub registry). Supports commit pinning (e.g., `github://hyperlane-xyz/hyperlane-registry/commit/abc123`) | No       |
| `SKIP_IGP_CLAIM`          | Set to "true" to skip IGP claims                                                                                                             | No       |
| `PROMETHEUS_PUSH_GATEWAY` | Prometheus push gateway URL (e.g., `http://prometheus-pushgateway:9091`)                                                                     | No       |
| `SERVICE_VERSION`         | Version identifier for logging (default: "dev")                                                                                              | No       |
| `LOG_LEVEL`               | Log level: DEBUG, INFO, WARN, ERROR                                                                                                          | No       |
| `LOG_FORMAT`              | Log format: JSON, PRETTY                                                                                                                     | No       |

In Kubernetes deployments, `HYP_KEY` and `RPC_URL_*` are injected via ExternalSecrets from GCP Secret Manager.

## Usage

### Docker

```bash
docker run -v /path/to/config.yaml:/config/keyfunder.yaml \
  -e KEYFUNDER_CONFIG_FILE=/config/keyfunder.yaml \
  -e HYP_KEY=0x... \
  -e RPC_URL_ETHEREUM=https://... \
  gcr.io/abacus-labs-dev/hyperlane-keyfunder:latest
```

### Local Development

```bash
# Build
pnpm build

# Run locally
KEYFUNDER_CONFIG_FILE=./config.yaml HYP_KEY=0x... RPC_URL_ETHEREUM=https://... pnpm start:dev
```

### Bundle

The service can be bundled into a single file using ncc:

```bash
pnpm bundle
# Output: ./bundle/index.js
```

## Funding Logic

### Key Funding

Keys are funded when their balance drops below 40% of the desired balance. The funding amount brings the balance up to the full desired balance.

**Example**: If `desiredBalance` is `1.0 ETH` and current balance is `0.39 ETH` (39%), funding is triggered. The key receives `0.61 ETH` to reach the full `1.0 ETH`.

### IGP Claims

When the IGP contract balance exceeds the claim threshold, accumulated fees are claimed to the funder wallet.

### Sweep

When the funder wallet balance exceeds `threshold * triggerMultiplier`, excess funds are swept to the safe address, leaving `threshold * targetMultiplier` in the wallet.

**Example**: With `threshold: '1.0'`, `triggerMultiplier: 2.0`, `targetMultiplier: 1.5`:

- If funder balance > 2.0 ETH, sweep is triggered
- After sweep, funder balance = 1.5 ETH

### Timeouts

Each chain is processed with a 60-second timeout. If funding operations for a chain exceed this limit, the chain is marked as failed and processing continues with remaining chains.

## Metrics

The service exposes Prometheus metrics:

| Metric                                           | Description                  |
| ------------------------------------------------ | ---------------------------- |
| `hyperlane_keyfunder_wallet_balance`             | Current wallet balance       |
| `hyperlane_keyfunder_funding_amount`             | Amount funded to a key       |
| `hyperlane_keyfunder_igp_balance`                | IGP contract balance         |
| `hyperlane_keyfunder_sweep_amount`               | Amount swept to safe address |
| `hyperlane_keyfunder_operation_duration_seconds` | Duration of operations       |

## Deployment

The service is typically deployed as a Kubernetes CronJob. See `typescript/infra/helm/key-funder/` for the Helm chart.

## License

Apache-2.0
