---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/sdk": minor
---

Made maxFeeBps mutable on TokenBridgeCctpV2 and increased fee precision from bps (1/10,000) to ppm (1/1,000,000) to support Circle's fractional basis point fees (e.g., 1.3 bps). SDK converts bps config to ppm for deployment and ppm back to bps when reading.
