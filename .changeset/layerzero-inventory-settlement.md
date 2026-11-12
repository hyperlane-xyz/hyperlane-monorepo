---
'@hyperlane-xyz/rebalancer': patch
---
LayerZero inventory settlement was bound to the accepted recipient, source OFT event, and confirmed destination receipt so unverified deliveries remained reserved. Preparation failures were classified before submission, and Tron addresses were normalized for token and signer checks.
