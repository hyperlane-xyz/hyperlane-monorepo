---
'@hyperlane-xyz/sdk': patch
---

Seismic signed reads and gas estimates used the connected provider's RPC fallback and custom connections, reused client initialization while refreshing replay protection, and exposed decrypted reverts as ethers-compatible errors. Authenticated reads retained explicit failures for unsupported signers.
