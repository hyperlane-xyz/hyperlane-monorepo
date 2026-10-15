---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
---

Signed reads for shielded token state on Seismic chains. `SeismicSigner.signedCall` issues an encrypted, EIP-712-signed `eth_call`; `MultiProviderAdapter` can carry Seismic chains' signers (`fromMultiProvider`, `setSeismicSigners`, `tryGetSeismicSigner`); `EvmTokenAdapter` reads the sender's own `balanceOf`/`allowance` as signed reads on Seismic when that signer is available. The CLI attaches the Seismic signers in `signerMiddleware`, so `warp send` from a Seismic origin no longer fails on shielded balance checks.

Numeric block tags in `SeismicSigner.signedCall` were normalized to JSON-RPC hex quantities, and invalid numeric block numbers were rejected before signing or issuing RPC requests.
