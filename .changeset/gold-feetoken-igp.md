---
'@hyperlane-xyz/sdk': patch
---

The relayer agent config schema was updated to recognize `feeToken` gas payment enforcement config and reject non-native exact-token enforcement until token-aware IGP indexing is available. ERC20 IGP payments can still satisfy token-agnostic `onChainFeeQuoting` checks through the indexed destination gas amount.
