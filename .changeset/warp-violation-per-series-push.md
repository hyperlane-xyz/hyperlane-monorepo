---
'@hyperlane-xyz/metrics': patch
---

Push gateway submission gained an optional `groupings` parameter and a new `deleteMetrics` helper, letting each metric be pushed under its own group and cleared independently via DELETE.
