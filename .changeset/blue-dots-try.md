---
"@hyperlane-xyz/cli": minor
---

Update `hyperlane submit` to use `promiseObjAll` instead of `for` loop to prevent safe API rate limiting. Output transaction unique receipts by generating the file name with chain and timestamp.
