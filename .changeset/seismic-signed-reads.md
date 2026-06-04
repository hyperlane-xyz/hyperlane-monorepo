---
"@hyperlane-xyz/sdk": minor
---

Added Seismic signed-read support for gas estimation. A new `ChainTechnicalStack.Seismic` value and a `SeismicSigner` were introduced so that, on Seismic chains, gas estimation for owner-gated functions is performed via a signed `eth_estimateGas` (a signed raw transaction from which the node recovers `msg.sender`) rather than an unsigned request where the `from` field is zeroed. Signers for chains with the Seismic technical stack are automatically wrapped by the MultiProvider.
