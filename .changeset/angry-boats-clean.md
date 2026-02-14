---
'@hyperlane-xyz/sdk': patch
---

Gnosis Safe utilities were expanded and centralized in the SDK, including Safe service initialization, signer resolution, retry helpers, transaction proposal and execution helpers, pending transaction queries, Safe owner update helpers, multisend decoding helpers, Safe deployment transaction building, and known multisend deployment address discovery.

Infra scripts were refactored to consume the SDK Safe utilities directly, duplicated infra Safe utility code was removed, and direct `@safe-global/*` infra dependencies used only for Safe utilities were dropped in favor of SDK helpers.

Safe utility typing and robustness were improved by:

- Modeling nullable tx-service fields in SDK Safe utility types.
- Widening Safe tx-service payload predicate boundaries to accept unknown runtime inputs while preserving strict payload-shape validation.
- Hardening Safe tx-service payload predicates to fail closed when hostile runtime payloads throw during field access.
- Hardening Safe API version parsing for real-world semver formats, including uppercase `V` prefixes, strict separator validation, safe-integer guards, and rejection of malformed/leading-zero numeric components.
- Hardening Safe API version parser boundaries with explicit non-string rejection and deterministic invalid-version messaging for unstringifiable runtime inputs.
- Tightening Safe tx payload validation with required hex calldata assertions, selector-length checks, and calldata normalization for uppercase `0X`, missing `0x` prefixes, surrounding whitespace, and uppercase payload casing.
- Strengthening hex normalization (`asHex`) with required-input checks, whitespace and prefix normalization, deterministic lowercase canonicalization, odd-length nibble rejection, and invalid-hex fail-fast checks.
- Widening parser input contracts (`parseSafeTx`, `decodeMultiSendData`, `asHex`) to accept unknown runtime values and validate at boundaries instead of relying on caller-side string casts.
- Hardening invalid-input error paths to safely handle unstringifiable runtime values while preserving deterministic, caller-level error messaging.
- Strengthening owner-diff invariants with duplicate-owner and invalid-address fail-fast checks.
- Normalizing Safe service URLs with host-only URL handling, non-http(s) scheme rejection, malformed authority/userinfo rejection, host-octet/Unicode/control-character authority guards, query/hash stripping, `/api` canonicalization, and explicit empty-value fail-fast assertions.
- Hardening Safe URL helper boundaries with explicit non-string input handling: fail-closed API-key requirement checks and deterministic normalization errors (including unstringifiable runtime values).
- Tightening Safe API key host matching with hostname boundary checks, trailing-dot normalization, malformed URL and userinfo spoof rejection (including encoded `@` and encoded backslash variants), and strict authority validation while preserving valid encoded path/query/fragment data.
- Hardening multisend decoding with pre-decode selector-length guards plus strict segment-boundary checks that reject truncated payload headers/bodies, overflowed data-length fields, unsupported operation values, and invalid deployment-version inputs (non-array lists, non-string elements, and empty/whitespace-only entries).
- Expanding safe transaction parser coverage across Safe methods (`execTransaction*`, `approveHash`, `setup`) and adding additional fail-fast assertions in deployment transaction utilities.
- Hardening Safe call transaction-data construction with boundary validation for payload/object shape, target address validity, calldata hex normalization, and deterministic unsigned-integer value serialization errors for malformed runtime inputs.
- Requiring typed-data signer support before Safe tx deletion.
