---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/cli": minor
---

Added TIP-20 warp route support for Tempo blockchain with two token variants: HypTIP20 (synthetic) for factory-created tokens and HypTIP20Collateral for existing TIP-20 tokens. Both variants support memo preservation for payment references and TIP-403 policy pre-flight checks for compliance. SDK and CLI updated with collateralTip20 and syntheticTip20 token types.
