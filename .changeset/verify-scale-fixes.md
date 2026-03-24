---
'@hyperlane-xyz/sdk': patch
---

Fixed verifyScale to reject mismatched scales when decimals are uniform across chains. Added positivity constraint to bigint scale schema fields. Improved decimals assertion to use nullish check instead of truthiness.
