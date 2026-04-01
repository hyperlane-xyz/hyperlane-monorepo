---
"@hyperlane-xyz/core": patch
---

Permit2 permit call in QuotedCalls was wrapped in try/catch to handle front-running gracefully. If an attacker submits the same permit signature first, the allowance is already set and execution continues without reverting.
