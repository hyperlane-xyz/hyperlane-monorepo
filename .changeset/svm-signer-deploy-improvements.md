---
'@hyperlane-xyz/sealevel-sdk': major
---

SVM transaction signing and program deployment reliability was improved. The send/confirm flow was refactored into separate signAndSend, send, and pollForConfirmation methods with a 60s wall-clock timeout, maxRetries: 0 to prevent RPC-side retry conflicts, fire-and-forget rebroadcast during polling, and structured @solana/errors-based blockhash error detection. Program deployment write stages are now sent in parallel batches using Promise.allSettled with sequential retry of failures, stage partitioning uses a typed DeployStageKind discriminant instead of label string matching, and the default write chunk size was adjusted to 850 bytes to safely support separate payer/authority signers.
