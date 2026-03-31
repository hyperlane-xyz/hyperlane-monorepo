---
'@hyperlane-xyz/core': patch
---

Added reentrancy guard using transient storage to QuotedCalls.execute and a corresponding test that verifies reentrant calls revert.
