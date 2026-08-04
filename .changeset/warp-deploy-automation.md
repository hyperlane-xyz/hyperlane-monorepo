---
'@hyperlane-xyz/sdk': minor
---

Added a Turnkey signer (EVM signer + Turnkey client) to the SDK for warp-route propose automation, exported from the package entrypoint. The EVM signer's EIP-712 typed-data signing submitted the full typed-data payload to Turnkey (PAYLOAD_ENCODING_EIP712) so Turnkey policies could inspect the domain and message fields rather than an opaque digest, and resolved ENS names in address-typed fields via the configured provider before encoding, mirroring ethers v5's own signer. The signer assembled Turnkey's raw signature response by accepting r/s as bare 32-byte hex (re-prefixed with 0x) and lifting the recovery-id v ("00"/"01") into the 27/28 space before joining, and rejected an unsupported or malformed recovery id instead of silently producing an unrecoverable signature.
