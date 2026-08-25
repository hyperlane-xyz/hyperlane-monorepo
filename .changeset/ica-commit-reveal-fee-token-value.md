---
'@hyperlane-xyz/core': patch
---

ICA fee-token dispatches were fixed to quote the actual remote router, message body, and resolved hook. Commit-reveal calls were changed to forward and refund only native value from the current call, leaving existing router balances untouched. Token-pulling child hooks still require explicit approval.
