---
'@hyperlane-xyz/utils': patch
---

Fixed `timeout()` to clear its internal `setTimeout` when the wrapped promise settles, preventing lingering timers from keeping the Node.js event loop alive.
