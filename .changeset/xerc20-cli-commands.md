---
"@hyperlane-xyz/cli": minor
---

The XERC20 commands were moved from `warp xerc20` to top-level `xerc20 read/apply`. The `apply` command now uses a declarative approach - specify expected XERC20 limits in the warp deploy config's `xERC20` field and the command auto-detects adds/updates/removals by comparing config vs on-chain state.
