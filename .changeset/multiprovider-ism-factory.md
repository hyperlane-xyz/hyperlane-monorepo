---
'@hyperlane-xyz/sdk': patch
---

MultiProvider was updated to cache connected signers for stable instance identity and route setProviders() through setProvider() for consistent signer reconnection. ISM factory now simulates deploy address via eth_call when getAddress() returns incorrect results. Defensive null assertions were added across MultiProvider methods. HyperlaneCore onDispatch errors are now caught and logged separately.
