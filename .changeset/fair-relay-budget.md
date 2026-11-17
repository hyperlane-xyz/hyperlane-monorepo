---
'@hyperlane-xyz/rebalancer': patch
---

Fixed Relay inventory transfers aborting on small quote changes by reserving a bounded execution budget before submission. Reduced approval churn, preserved HTTP errors and rate-limit cooldowns, corrected chain-ID lookup, and surfaced transfers requiring manual reconciliation.
