---
'@hyperlane-xyz/core': minor
---

Fixed misuse of aggregation hook funds for relaying messages by making sure msg.value is adequate and refunding if excess.
