---
"@hyperlane-xyz/cli": major
---

CLI warp route reference methods were consolidated into a single `--warp-route-id` flag with `-w` and `--id` aliases. The `--config/-wd` (deploy config path) and `--warp/-wc` (warp config path) flags were removed in favor of registry-based warp route IDs. Symbol-only references (for example, `-w ETH`) now auto-resolve when unique or prompt for selection when multiple matches exist.

Migration examples:

- Before: `hyperlane warp deploy --config ./config.yaml`
- After: `hyperlane warp deploy -w ETH/ethereum-arbitrum`
