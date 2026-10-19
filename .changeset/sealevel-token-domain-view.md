---
'@hyperlane-xyz/sealevel-sdk': patch
---

The embedded Sealevel token programs were rebuilt so that transfer_remote, handle and the ISM getter read only the needed domain's router and destination gas from the token account instead of deserializing every enrolled domain. This saved ~585 CU per enrolled domain on each of those instructions. The account layout was unchanged. Deployed programs must be upgraded to get the savings.
