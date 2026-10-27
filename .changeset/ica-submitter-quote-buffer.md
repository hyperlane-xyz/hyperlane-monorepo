---
'@hyperlane-xyz/sdk': patch
---

The ICA tx submitter doubled the IGP quote sent with callRemote, so ICA batches proposed via warp apply no longer reverted when IGP gas prices rose before execution. Overpayment was refunded to the owner.
