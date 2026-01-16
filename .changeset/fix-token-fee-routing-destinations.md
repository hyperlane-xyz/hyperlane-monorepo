---
'@hyperlane-xyz/sdk': patch
---

Fixed EvmTokenFeeModule to derive routingDestinations from target config when not explicitly provided. This ensures sub-fee contracts are properly read from on-chain when updating RoutingFee configurations. Also added support for deploying new sub-fee contracts when adding destinations to an existing RoutingFee.
