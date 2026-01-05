---
"@hyperlane-xyz/rebalancer": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/infra": minor
---

Moved rebalancer-specific type definitions from `@hyperlane-xyz/sdk` to `@hyperlane-xyz/rebalancer`. Updated CLI and infra imports to use the new location. The rebalancer package is now self-contained and doesn't pollute the SDK with rebalancer-specific types.
