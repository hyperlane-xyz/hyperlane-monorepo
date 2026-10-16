---
'@hyperlane-xyz/sdk': patch
---

`SeismicSigner.estimateGas` was updated to decrypt an encrypted revert the same way `signedCall` does. A signed gas estimate on Seismic that reverts (for example a `transferRemote` rejected by a post-dispatch hook) previously surfaced the node's ciphertext as the error data; the ABI revert data is now exposed so callers can decode the reason.
