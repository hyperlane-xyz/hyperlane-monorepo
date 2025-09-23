---
"@hyperlane-xyz/sdk": patch
---

Avoid extra Safe API call when only creating local JSON files for manual upload. When proposing, the Safe UI will automatically update the tx nonce. So we can return 0 and save ourselves from Safe API unreliability.
