---
"@hyperlane-xyz/cli": major
---

The CLI warp route reference methods were consolidated into a single --warp-route-id flag with --id alias. The --config/-wd (deploy config path) and --warp/-wc (warp config path) flags were removed in favor of registry-based warp route IDs. Symbol-only references (e.g., `-w ETH`) were added that auto-resolve when unique or prompt for selection when multiple matches exist.
