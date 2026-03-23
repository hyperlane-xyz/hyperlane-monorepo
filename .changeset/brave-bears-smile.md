---
"@hyperlane-xyz/sdk": major
---

The bps type was changed from bigint to number throughout the LinearFee fee system to support fractional basis points (e.g., 1.5 bps).

Breaking changes:
- `convertToBps()` return type changed from `bigint` to `number`
- `convertFromBps()` parameter type changed from `bigint` to `number`
- `LinearFeeConfig.bps` and `LinearFeeInputConfig.bps` types changed from `bigint` to `number`
- `ZBps` schema no longer accepts `bigint` input — callers using `bps: 5n` must change to `bps: 5`
- `TokenFeeConfigSchema` and `LinearFeeConfigSchema` bps field type changed from `bigint` to `number`
