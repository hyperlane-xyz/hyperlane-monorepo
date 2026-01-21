---
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/aleo-sdk': patch
---

Routing ISM logic extracted into base classes in provider-sdk. Protocol SDKs now extend BaseRoutingIsmRawReader and BaseRoutingIsmRawWriter, eliminating ~450 lines of duplicated code across radix-sdk, cosmos-sdk, and aleo-sdk.
