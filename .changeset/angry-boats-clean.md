---
'@hyperlane-xyz/sdk': patch
---

Gnosis Safe utilities were expanded and centralized in the SDK, including Safe service initialization, signer resolution, retry helpers, transaction proposal and execution helpers, pending transaction queries, Safe owner update helpers, multisend decoding helpers, Safe deployment transaction building, and known multisend deployment address discovery.

Infra scripts were refactored to consume the SDK Safe utilities directly, duplicated infra Safe utility code was removed, and direct `@safe-global/*` infra dependencies used only for Safe utilities were dropped in favor of SDK helpers.
