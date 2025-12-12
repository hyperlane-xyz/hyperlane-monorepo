---
"@hyperlane-xyz/cli": minor
---

Update `hyperlane submit` to use a sequential `for` loop instead of `promiseObjAll` to prevent API rate limiting, Output transaction receipts as unique JSON files per chain with timestamped filenames.
