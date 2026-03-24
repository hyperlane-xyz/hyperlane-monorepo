---
'@hyperlane-xyz/sdk': patch
---

Added support for scale-down convention in verifyScale, accepting both scale-up and scale-down routes for cross-decimal configurations. Fixed verifyScale to reject mismatched scales when decimals are uniform across chains. Added positivity constraint to bigint scale schema fields. Improved decimals assertion to use nullish check instead of truthiness.
