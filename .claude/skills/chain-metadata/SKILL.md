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

## Implementation

```bash
meta() {
  local registry="${HYPERLANE_REGISTRY:-$HOME/hypkey/hyperlane-registry}"
  local keypath=$2
  [[ $keypath == "rpc" ]] && keypath="rpcUrls.0.http"
  [[ $keypath =~ ^rpc[0-9]+$ ]] && keypath="rpcUrls.${keypath#rpc}.http"
  cat "${registry}/chains/${1}/metadata.yaml" | yq -r ".${keypath}"
}
```

Requires: `yq` installed, registry cloned to `$HOME/hypkey/hyperlane-registry`
