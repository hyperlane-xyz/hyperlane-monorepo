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

## Setup

The `addr` function is defined in the team's Runes. See the [Runes Notion page](https://www.notion.so/hyperlanexyz/Runes-1616d35200d680b3a0dafcbd37e89ad3) for setup instructions.

Requires:

- `yq` installed (`brew install yq`)
- Registry cloned at `$HOME/hypkey/hyperlane-registry` (run `update_hypkey` to set up)
