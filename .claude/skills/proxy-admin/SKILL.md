---
name: proxy-admin
description: Gets the proxy admin address for EIP-1967 transparent proxy contracts. Use when checking who can upgrade a warp route, mailbox, or other proxy contract.
---

# Proxy Admin Lookup

Get the proxy admin for any EIP-1967 proxy:

```bash
proxyAdmin <address> <chain>
```

## Examples

```bash
proxyAdmin 0xWarpRouteAddress ethereum
proxyAdmin $(addr arbitrum mailbox) arbitrum
```

## Technical Details

Reads EIP-1967 admin slot: `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`

## Implementation

```bash
proxyAdmin() {
  local rpc=$(meta $2 rpc)
  cast parse-bytes32-address $(cast storage $1 \
    0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 \
    --rpc-url "$rpc")
}
```

Requires: Foundry (`cast`), `meta` function configured
