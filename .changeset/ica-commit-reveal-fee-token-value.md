---
'@hyperlane-xyz/core': minor
---

ICA fee-token dispatches were fixed to quote the actual remote router, message body, and resolved hook. QuotedCalls ICA commands were changed to reconstruct the messages they execute, and Minimal ICA routers gained support for salted calls. Commit-reveal calls were changed to forward and refund only native value from the current call, leaving existing router balances untouched. Token-pulling child hooks still require explicit approval.

Existing immutable ICA routers are not supported for these fee-token commands. The updated QuotedCalls and ICA routers must be deployed together, and registry configuration must be migrated to the paired deployments.
