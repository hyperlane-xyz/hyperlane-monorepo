---
"@hyperlane-xyz/sdk": patch
---

Removed Cosmostation validators from the default multisig ISM configs for celestia, eden, forma, mantapacific, neutron, and stride, and set each chain's threshold to the minimum majority value (`floor(n/2) + 1`) enforced by `multisigIsm.test.ts`.
