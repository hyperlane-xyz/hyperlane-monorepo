---
"@hyperlane-xyz/cli": patch
---

Fixed submit command failing with "warp id not provided" error by creating dedicated chain resolver that reads transaction file to determine required chains.
