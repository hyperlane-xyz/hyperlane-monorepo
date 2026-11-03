---
'@hyperlane-xyz/sdk': patch
---

`WarpCore.getLocalTransferFee` was updated to simulate the transfer with the actual recipient instead of the sender's address. Origin-side policies that inspect the recipient (for example an allowlist post-dispatch hook or a Sealevel fee program) rejected the placeholder, so a valid transfer failed pre-flight validation. `validateTransfer`, `estimateTransferRemoteFees`, `estimateCrossCollateralFees` and `getMaxTransferAmount` now pass the recipient through; the sender fallback is kept when none is given.
