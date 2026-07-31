---
'@hyperlane-xyz/sdk': minor
---

Added a Turnkey signer (EVM signer + Turnkey client) to the SDK for warp-route propose automation, exported from the package entrypoint. The EVM signer's EIP-712 typed-data signing submits the full typed-data payload to Turnkey (PAYLOAD_ENCODING_EIP712) so Turnkey policies can inspect the domain and message fields rather than an opaque digest.
