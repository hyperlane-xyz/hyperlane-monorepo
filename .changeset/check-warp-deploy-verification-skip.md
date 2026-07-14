---
"@hyperlane-xyz/sdk": patch
---

The warp route contract verification check now skips chains that have no Etherscan-API-compatible block explorer configured. Previously these chains (e.g. tronscan, zksync, keyless etherscan) produced an `Error` verification status that surfaced as a false-positive `ContractVerificationStatus` violation in `check-warp-deploy`; they are now reported as `Skipped`.
