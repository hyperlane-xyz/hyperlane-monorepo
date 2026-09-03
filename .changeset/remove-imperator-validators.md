---
'@hyperlane-xyz/sdk': patch
---

The acquired Imperator validator was removed from the default multisig ISM configs on celo, ethereum, fraxtal, lisk, metal, mode, optimism, soneium, unichain, and worldchain, following its shutdown on swellchain and prior removal on ink. Thresholds were re-derived to preserve a minimum honest majority (`floor(n/2) + 1`): celo 4→3, lisk 5→4, metal 4→3, mode 4→3, optimism 4→3, soneium 4→3, and worldchain 4→3. ethereum keeps threshold 6 (now 6/9), and fraxtal and unichain keep threshold 3 (now 3/4). forma and superseed retain Imperator for now (forma keeps its current set; superseed is deprecating shortly).
