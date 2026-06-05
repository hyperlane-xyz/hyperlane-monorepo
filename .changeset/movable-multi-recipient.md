---
'@hyperlane-xyz/core': major
---

MovableCollateralRouter now supports multiple allowed rebalance recipients per domain. The single-recipient override was replaced with a per-domain set: `allowedRecipient(uint32)` became `allowedRecipients(uint32)` (returns `bytes32[]`), `isAllowedRecipient(uint32,bytes32)` was added, `setRecipient(uint32,bytes32)` became `addRecipient(uint32,bytes32)`, and `removeRecipient(uint32)` became `removeRecipient(uint32,bytes32)`. A new `rebalance(uint32,bytes32,uint256,ITokenBridge)` overload targets a specific allowed recipient (the original 3-arg overload defaults to the enrolled remote router). `AtomicLocalRebalancingBridge.localRebalance` gained a `destinationRecipient` argument.
