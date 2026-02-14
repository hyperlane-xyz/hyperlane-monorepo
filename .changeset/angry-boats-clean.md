---
'@hyperlane-xyz/sdk': patch
---

Gnosis Safe utilities were expanded and centralized in the SDK, including Safe service initialization, signer resolution, retry helpers, transaction proposal and execution helpers, pending transaction queries, Safe owner update helpers, multisend decoding helpers, Safe deployment transaction building, and known multisend deployment address discovery.

Infra scripts were refactored to consume the SDK Safe utilities directly, duplicated infra Safe utility code was removed, and direct `@safe-global/*` infra dependencies used only for Safe utilities were dropped in favor of SDK helpers.

Safe utility typing and robustness were improved by:

- Modeling nullable tx-service fields in SDK Safe utility types.
- Hardening Safe API version parsing for real-world semver formats, including uppercase `V` prefixes, strict separator validation, safe-integer guards, and rejection of malformed/leading-zero numeric components.
- Tightening Safe tx payload validation with required hex calldata assertions, selector-length checks, and calldata normalization for uppercase `0X`, missing `0x` prefixes, surrounding whitespace, and uppercase payload casing.
- Strengthening hex normalization (`asHex`) with required-input checks, whitespace and prefix normalization, deterministic lowercase canonicalization, and invalid-hex fail-fast checks.
- Strengthening owner-diff invariants with duplicate-owner and invalid-address fail-fast checks.
- Normalizing Safe service URLs with host-only URL handling, non-http(s) scheme rejection, malformed authority/userinfo rejection, host-octet/Unicode/control-character authority guards, query/hash stripping, `/api` canonicalization, and explicit empty-value fail-fast assertions.
- Tightening Safe API key host matching with hostname boundary checks, trailing-dot normalization, malformed URL and userinfo spoof rejection (including encoded `@` and encoded backslash variants), and strict authority validation while preserving valid encoded path/query/fragment data.
- Hardening multisend decoding with strict segment-boundary checks that reject truncated payload headers/bodies, overflowed data-length fields, unsupported operation values, and invalid/whitespace-only deployment version inputs.
- Expanding safe transaction parser coverage across Safe methods (`execTransaction*`, `approveHash`, `setup`) and adding additional fail-fast assertions in deployment transaction utilities.
- Requiring typed-data signer support before Safe tx deletion.
