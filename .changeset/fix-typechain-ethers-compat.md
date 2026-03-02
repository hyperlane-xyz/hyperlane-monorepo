---
'@hyperlane-xyz/core': patch
---

Fix typechain ethers v5/v6 webpack compat by replacing `import { utils } from "ethers"` with direct `Interface` import from `@ethersproject/abi` in generated factory files.
