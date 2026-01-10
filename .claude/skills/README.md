# Hyperlane AI Skills

Skills for common Hyperlane operations, automatically discovered by Claude.

## Available Skills

| Skill                  | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `chain-metadata`       | Query chain metadata (chainId, domainId, RPCs) |
| `registry-address`     | Look up contract addresses from registry       |
| `explorer-api`         | Query Hyperlane Explorer for message status    |
| `debug-stuck-messages` | Diagnose pending/stuck messages                |

## Prerequisites

- **yq**: `brew install yq`
- **jq**: `brew install jq`
- **Registry**: Clone to `$HOME/hypkey/hyperlane-registry`

## Shell Setup

See the [Runes documentation](https://www.notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) for shell helper setup (`addr`, `meta`, etc.).

## Related

- [CLAUDE.md](../../CLAUDE.md) - Main AI guidance
- [Runes (Notion)](https://notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) - Full shell helpers including sensitive operations
