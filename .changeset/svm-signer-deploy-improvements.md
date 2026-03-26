---
'@hyperlane-xyz/sealevel-sdk': major
---

SvmSigner send/confirm flow was refactored with block-height-based polling, client-side rebroadcast, structured blockhash error detection via @solana/errors, and double-execution prevention for processed transactions. Program deployment write stages are now sent in parallel batches with retry on failure. Breaking: DeployStage requires a new `kind` field (DeployStageKind discriminant).
