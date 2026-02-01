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
- **Runes**: Shell helpers configured (see below)

## Shell Setup

These skills use the **Runes** shell helpers (`addr`, `meta`, etc.) as the interface. The Runes can be configured to point to your local registry clone, wherever it lives.

See the [Runes documentation](https://www.notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) for setup instructions.

## Related

- [CLAUDE.md](../../CLAUDE.md) - Main AI guidance
- [Runes (Notion)](https://notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) - Full shell helpers including sensitive operations
