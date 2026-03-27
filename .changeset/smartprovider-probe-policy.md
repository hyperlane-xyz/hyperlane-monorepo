---
'@hyperlane-xyz/sdk': patch
---

SmartProvider probe reads were changed to treat deterministic ABI misses and expected reverts as non-retriable negative matches while preserving fallback for transient provider failures. Warp route, hook, and ISM readers were updated to use the new probe helpers so type discovery no longer fans out across providers on expected probe failures.
