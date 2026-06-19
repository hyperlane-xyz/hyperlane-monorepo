---
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/infra": patch
---

Fixed ISM initialization guard on retry, added in-place ISM sub-module updates for AGGREGATION and AMOUNT_ROUTING containers (with side-effect-free preflight, duplicate-key checks, CCIP cache propagation, and nested RATE_LIMITED support), and made Safe nonce fetching queue-aware with a manual override escape hatch.
