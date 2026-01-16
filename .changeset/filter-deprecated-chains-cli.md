---
'@hyperlane-xyz/cli': patch
---

Deprecated chains are now filtered out from CLI interactive prompts and the `hyperlane registry list` command output. This prevents users from accidentally selecting deprecated chains when deploying warp routes, sending messages, or running relayers.
