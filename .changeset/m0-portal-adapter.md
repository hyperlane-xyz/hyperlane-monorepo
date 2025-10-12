---
'@hyperlane-xyz/sdk': minor
---

Add M0 PortalLite token adapter support for bridging M tokens

- Add new TokenStandard.EvmM0PortalLite for M0 Portal integration
- Implement M0PortalLiteTokenAdapter for handling M0 token transfers
- Support for M0's transferMLikeToken function to bridge wrapped M tokens (e.g., mUSD)
- Built-in gas estimation via Portal's quoteTransfer function
