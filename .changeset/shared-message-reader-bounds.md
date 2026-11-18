---
'@hyperlane-xyz/scraper-proxy': patch
---

Shared message reader bursts and payment facts were bounded: a rollback refreshes only rows with a fact above the new frontier on the rolled-back domain, and gas payments keep the oldest and newest heights per domain exact while folding the middle, so no number of permissionless payments can error or disconnect a message's subscribers.
