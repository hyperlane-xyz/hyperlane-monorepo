---
'@hyperlane-xyz/utils': patch
---

Fix `parseMessage` crash in browser environments by using `readUInt8` instead of the Node.js 16+ `readUint8` alias, which is missing from common Buffer polyfills.
