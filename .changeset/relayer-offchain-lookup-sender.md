---
'@hyperlane-xyz/relayer': patch
---

The CCIP-read metadata builder rejects an offchain lookup whose sender is not the queried ISM, before signing or sending any request.
