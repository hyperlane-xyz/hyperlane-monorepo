---
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/widgets': patch
---

Removed Aleo deployment artifacts, the Provable runtime, and the Shield wallet adapter from eager browser bundles. Lightweight constants and program metadata stayed synchronous, while browser providers and wallet integrations loaded their protocol runtimes on first use.
