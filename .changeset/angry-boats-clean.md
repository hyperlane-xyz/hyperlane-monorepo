---
'@hyperlane-xyz/sdk': patch
---

Gnosis Safe utilities were expanded and centralized in the SDK, including Safe service initialization, signer resolution, retry helpers, transaction proposal and execution helpers, pending transaction queries, Safe owner update helpers, multisend decoding helpers, Safe deployment transaction building, and known multisend deployment address discovery.

Infra scripts were refactored to consume the SDK Safe utilities directly, duplicated infra Safe utility code was removed, and direct `@safe-global/*` infra dependencies used only for Safe utilities were dropped in favor of SDK helpers.

Safe utility typing and robustness were improved by modeling nullable tx-service fields, hardening Safe API version parsing for real-world semver formats, tightening Safe tx payload validation, normalizing Safe service URLs (including host-only URL handling via inferred `https://`, protocol/hostname URL parse guards, case-insensitive `/api` canonicalization, whitespace trimming, and query/hash stripping), tightening Safe API key host matching (including host-only inputs, host-with-port parsing, trailing-dot FQDN normalization, and subdomain-boundary checks), adding deployment transaction fail-fast assertions, and requiring typed-data signer support before Safe tx deletion.
