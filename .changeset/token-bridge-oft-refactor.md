---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/core': patch
---

TokenBridgeOft was refactored to remove TokenRouter inheritance, implementing ITokenBridge directly with OwnableUpgradeable. The contract no longer requires a mailbox, remote router enrollment, or destination gas configuration. Fee recipient support was removed and OFT fee quotes were consolidated into a single token quote entry. SDK deployer, warp route reader, and warp module were updated to handle OFT configs separately from Router-based configs.
