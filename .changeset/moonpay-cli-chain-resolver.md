---
"@hyperlane-xyz/cli": patch
---

resolveWarpConfigChains now includes chains referenced by the submission strategy (e.g. ICA origin chains) so signers are initialised for them before transaction submission.
