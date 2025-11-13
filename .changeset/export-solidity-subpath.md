---
"@hyperlane-xyz/core": patch
---

Export Solidity contracts subpaths via package.json to enable deep imports

Add wildcard export mapping `"./contracts/*": "./contracts/*"` to enable downstream projects to import Solidity contracts directly using paths like `@hyperlane-xyz/core/contracts/Mailbox.sol` without requiring `node_modules/` prefixes or vendoring.
