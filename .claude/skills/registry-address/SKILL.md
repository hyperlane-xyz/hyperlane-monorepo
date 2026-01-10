---
name: registry-address
description: Looks up contract addresses from the Hyperlane registry. Use when finding mailbox, validatorAnnounce, proxyAdmin, IGP, or other Hyperlane contract addresses for any chain.
---

# Registry Address Lookup

Look up contract addresses using the `addr` function:

```bash
addr <chain> <contractName>
```

## Examples

```bash
addr ethereum mailbox           # 0xc005dc82818d67AF737725bD4bf75435d065D239
addr arbitrum validatorAnnounce
addr optimism interchainGasPaymaster
```

## Common Contract Names

- `mailbox` - Core messaging hub
- `validatorAnnounce` - Validator announcements
- `proxyAdmin` - Proxy admin for upgrades
- `interchainGasPaymaster` - IGP for gas payments
- `merkleTreeHook` - Merkle tree hook
- `interchainSecurityModule` - Default ISM

## Implementation

```bash
addr() {
  local registry="${HYPERLANE_REGISTRY:-$HOME/hypkey/hyperlane-registry}"
  cat "${registry}/chains/${1}/addresses.yaml" | yq -r ".${2}"
}
```

Requires: `yq` installed, registry cloned to `$HOME/hypkey/hyperlane-registry`
