---
'@hyperlane-xyz/sdk': patch
---

Normalized Cairo token metadata and domains to the SDK's numeric types and remote router identifiers to 32-byte buffers, fixing Starknet route enumeration and metadata validation.

Added a reusable `ZUint32` schema for converting uint32 numbers, bigints, and decimal strings to validated numbers.
