---
'@hyperlane-xyz/sdk': patch
---

Gnosis Safe utilities were expanded and centralized in the SDK, including Safe service initialization, retry helpers, transaction proposal and execution helpers, pending transaction queries, Safe owner update helpers, and multisend decoding helpers.

Infra scripts were refactored to consume the SDK Safe utilities directly, and the duplicated infra Safe utility module was removed.
