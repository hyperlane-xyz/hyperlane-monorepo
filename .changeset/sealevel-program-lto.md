---
'@hyperlane-xyz/sealevel-sdk': patch
---

The embedded Sealevel program binaries were rebuilt with fat LTO, cutting total compute units by 1.5-7% per program across the functional suites. Each program now builds its ELF from a cdylib-only package because cargo skipped LTO for crates that built both cdylib and rlib. Deployed programs must be upgraded to get the savings.
