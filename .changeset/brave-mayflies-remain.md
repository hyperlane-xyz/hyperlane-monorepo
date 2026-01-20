---
'@hyperlane-xyz/cli': minor
---

Added `--ica` flag to `hyperlane warp check` command for verifying ICA (Interchain Account) ownership across destination chains. When used with `--origin` and optionally `--destinations`, the command checks that destination chain owners match expected ICA addresses derived from the origin chain owner. Non-EVM chains are automatically skipped with a warning.
