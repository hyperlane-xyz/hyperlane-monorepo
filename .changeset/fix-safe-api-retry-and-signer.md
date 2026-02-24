---
'@hyperlane-xyz/sdk': patch
---

Added retry logic for Safe Transaction Service API calls to handle 429 rate limits during multi-chain operations. Fixed signer passthrough in EV5GnosisSafeTxSubmitter.create(). Extracted shared Safe init logic to reduce duplication between EV5GnosisSafeTxSubmitter and EV5GnosisSafeTxBuilder.
