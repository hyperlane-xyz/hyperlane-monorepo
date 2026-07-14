---
"@hyperlane-xyz/sealevel-sdk": patch
---

Fixed SVM warp-route program upgrades failing transaction simulation on clusters where the `enable_extend_program_checked` feature gate is inactive (e.g. Solana mainnet-beta). `prepareProgramUpgrade` now queries the feature gate and emits the legacy `ExtendProgram` (variant 6) instruction when the checked variant is unavailable, and clamps the program-data extend up to the loader's 10240-byte minimum instead of requesting the exact deficit (which the loader rejects). Added a generic `isFeatureActive` gate checker and a `program-extend-upgrade` e2e that exercises the unchecked extend path end-to-end against a feature-deactivated validator.
