---
"@hyperlane-xyz/rebalancer": patch
---

Split inventory execution and e2e route fixture setup into dedicated modules so intent resolution, inventory planning, bridge capacity estimation, inventory movement, transferRemote execution, and local fixture deploy/enroll/seed behavior can be tested and evolved independently.
