---
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/sdk': patch
---

Removed Aleo deployment artifacts and the Provable runtime from eager SDK consumer bundles. Lightweight constants and program metadata stayed synchronous, while the default Aleo provider loaded its protocol runtime on first use.
