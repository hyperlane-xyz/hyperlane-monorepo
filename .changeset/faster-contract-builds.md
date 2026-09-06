---
'@hyperlane-xyz/core': patch
'@hyperlane-xyz/starknet-core': patch
---

Reduced contract build times by compiling Tron without shared source mutations, retaining its incremental compiler cache, and parallelizing Starknet artifact generation. Generated contract artifacts were preserved.
