---
'@hyperlane-xyz/cli': patch
---

Disabled chains (including deprecated ones) are now filtered out from CLI interactive prompts and the `hyperlane registry list` command output. This prevents users from accidentally selecting unsupported chains when deploying warp routes, sending messages, or running relayers.
