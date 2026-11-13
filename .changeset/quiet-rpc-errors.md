---
'@hyperlane-xyz/utils': minor
---

`redactSecrets`, `redactErrorMessage`, `redactErrorStack`, `REDACTED_URL` and `REDACTED_HOST` were added to remove URLs and hostnames from error text before it is logged. `redactErrorStack` keeps the stack frames and redacts only the error message inside the stack.
