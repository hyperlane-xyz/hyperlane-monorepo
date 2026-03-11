---
"@hyperlane-xyz/multicollateral": major
"@hyperlane-xyz/sdk": major
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/warp-monitor": minor
---

MultiCollateral contracts and SDK/CLI terminology were renamed to CrossCollateral.

The Solidity ABI was updated with renamed contracts, interfaces, router enrollment methods, domain/route getters, fee-quote method, events, and revert prefixes.

The SDK token type was migrated to `crossCollateral`, while legacy `multiCollateral` config values were still accepted during parsing and normalized to `crossCollateral`.

Reader compatibility for legacy deployed contracts was retained by falling back to legacy enrolled-router/domain ABI methods when renamed methods were unavailable.
