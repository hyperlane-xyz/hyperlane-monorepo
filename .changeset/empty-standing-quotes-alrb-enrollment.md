---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/sealevel-sdk': patch
---

Prevented atomic local rebalancing bridges from replacing trusted remote token routers during enrollment. Preserved standing-quote reads when an uninitialized SVM quote PDA was prefunded with an empty system account.
