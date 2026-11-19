---
'@hyperlane-xyz/scraper-proxy': patch
---

The shared message reader was made cheaper per subscriber: identical frames are encoded once, retained history is trimmed to the lowest active frontier, and provisional exposure is pruned lazily and keyed on visible fact heights.
