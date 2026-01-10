# Hyperlane AI Skills

Skills for common Hyperlane operations, automatically discovered by Claude.

## Available Skills

| Skill                  | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `registry-address`     | Look up contract addresses from registry       |
| `chain-metadata`       | Query chain metadata (chainId, domainId, RPCs) |
| `proxy-admin`          | Get proxy admin for EIP-1967 proxies           |
| `explorer-api`         | Query Hyperlane Explorer for message status    |
| `debug-stuck-messages` | Diagnose pending/stuck messages                |
| `validator-health`     | Check validator status and health              |
| `rpc-rotation`         | Rotate RPC providers                           |

## Prerequisites

- **yq**: `brew install yq`
- **jq**: `brew install jq`
- **Foundry**: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- **GCP CLI** (for internal operations): `brew install google-cloud-sdk && gcloud auth login`

## Shell Setup

See the [Runes documentation](https://notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) for shell helper setup (`addr`, `meta`, `rpc`, etc.).

## Related

- [CLAUDE.md](../../CLAUDE.md) - Main AI guidance
- [Runes (Notion)](https://notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) - Full shell helpers including sensitive operations
