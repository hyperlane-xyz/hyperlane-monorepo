---
'@hyperlane-xyz/sealevel-sdk': patch
---

The embedded Sealevel program binaries were rebuilt with lower compute-unit costs: hyperlane-core hashing used the sol_keccak256 syscall, PDA checks used stored bumps, program logs were formatted without allocation, and IGP and fee math used u128 fast paths with single-entry gas oracle reads. Some program log lines were reworded; the mailbox "Dispatched message to {domain}, ID 0x{id}" line was unchanged. Deployed programs must be upgraded to get the savings.
