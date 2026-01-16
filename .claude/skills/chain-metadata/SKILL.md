---
name: chain-metadata
description: Looks up chain metadata from the Hyperlane registry. Use when finding chainId, domainId, RPC URLs, native token info, or block explorer URLs for any chain.
---

# Chain Metadata Lookup

Look up chain metadata using the `meta` function:

```bash
meta <chain> <field>
```

## Examples

```bash
meta ethereum chainId           # 1
meta arbitrum domainId          # 42161
meta optimism nativeToken.symbol # ETH
meta polygon rpc                # First public RPC URL
meta polygon rpc1               # Second RPC URL
```

## Common Fields

- `chainId` - EVM chain ID
- `domainId` - Hyperlane domain ID
- `name` - Chain name
- `protocol` - Protocol type (ethereum, cosmos, sealevel)
- `nativeToken.symbol` - Native token symbol
- `rpcUrls.0.http` - First RPC URL (shortcut: `rpc`)
- `blockExplorers.0.url` - Block explorer URL

## Setup

The `meta` function is defined in the team's Runes. See the [Runes Notion page](https://www.notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) for setup instructions.

Requires:

- `yq` installed (`brew install yq`)
- Registry cloned at `$HOME/hypkey/hyperlane-registry` (run `update_hypkey` to set up)
