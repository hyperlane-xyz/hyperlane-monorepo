---
'@hyperlane-xyz/cli': minor
---

Added --chains option to `warp check` command for filtering which chains to check in both ICA and non-ICA modes. Unknown chains are skipped with a warning. For ICA mode, origin is always included in the filter to preserve owner lookup.
