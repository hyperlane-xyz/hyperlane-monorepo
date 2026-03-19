---
"@hyperlane-xyz/sdk": minor
---

Changed bps type from bigint to number in LinearFee schemas and conversion utilities. This enables fractional basis point fees (e.g., 1.5 bps). convertToBps now returns number, convertFromBps accepts number. Existing integer bps values (5, 8, 10) remain backward compatible.
