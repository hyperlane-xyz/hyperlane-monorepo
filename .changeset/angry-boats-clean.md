---
'@hyperlane-xyz/sdk': patch
---

Gnosis Safe utilities were expanded and centralized in the SDK, including Safe service initialization, signer resolution, retry helpers, transaction proposal and execution helpers, pending transaction queries, Safe owner update helpers, multisend decoding helpers, Safe deployment transaction building, and known multisend deployment address discovery.

Infra scripts were refactored to consume the SDK Safe utilities directly, duplicated infra Safe utility code was removed, and direct `@safe-global/*` infra dependencies used only for Safe utilities were dropped in favor of SDK helpers.

Safe utility typing and robustness were improved by:

- Modeling nullable tx-service fields in SDK Safe utility types.
- Widening Safe tx-service payload predicate boundaries to accept unknown runtime inputs while preserving strict payload-shape validation.
- Hardening Safe tx-service payload predicates to fail closed when hostile runtime payloads throw during field access.
- Hardening Safe transaction/call payload parsing to fail closed when hostile runtime payloads throw during field access.
- Validating Safe transaction payload object shape before parsing calldata to provide deterministic boundary errors for non-object runtime inputs.
- Hardening Safe API version parsing for real-world semver formats, including uppercase `V` prefixes, strict separator validation, safe-integer guards, and rejection of malformed/leading-zero numeric components.
- Hardening Safe API version parser boundaries with explicit missing/whitespace-only checks, non-string rejection, and deterministic invalid-version messaging for unstringifiable runtime inputs.
- Tightening Safe tx payload validation with required hex calldata assertions, selector-length checks, and calldata normalization for uppercase `0X`, missing `0x` prefixes, surrounding whitespace, and uppercase payload casing.
- Strengthening hex normalization (`asHex`) with required-input checks, whitespace and prefix normalization, deterministic lowercase canonicalization, odd-length nibble rejection, and invalid-hex fail-fast checks.
- Widening parser input contracts (`parseSafeTx`, `decodeMultiSendData`, `asHex`) to accept unknown runtime values and validate at boundaries instead of relying on caller-side string casts.
- Hardening invalid-input error paths to safely handle unstringifiable runtime values while preserving deterministic, caller-level error messaging.
- Strengthening owner-diff invariants with duplicate-owner and invalid-address fail-fast checks.
- Strengthening owner-diff input boundaries with array-shape validation, fail-closed handling for inaccessible list metadata/entries, and deterministic non-string owner-entry rejection before duplicate/address checks.
- Validating owner-list and deployment-version list lengths as safe non-negative integers before iteration to reject hostile runtime list metadata.
- Normalizing Safe service URLs with host-only URL handling, non-http(s) scheme rejection, malformed authority/userinfo rejection, host-octet/Unicode/control-character authority guards, query/hash stripping, `/api` canonicalization, and explicit empty-value fail-fast assertions.
- Hardening Safe URL helper boundaries with explicit non-string input handling: fail-closed API-key requirement checks and deterministic normalization errors (including unstringifiable runtime values).
- Tightening Safe API key host matching with hostname boundary checks, trailing-dot normalization, malformed URL and userinfo spoof rejection (including encoded `@` and encoded backslash variants), and strict authority validation while preserving valid encoded path/query/fragment data.
- Hardening multisend decoding with pre-decode selector-length guards plus strict segment-boundary checks that reject truncated payload headers/bodies, overflowed data-length fields, unsupported operation values, and invalid deployment-version inputs (non-array lists, inaccessible list metadata/entries, non-string elements, and empty/whitespace-only entries).
- Normalizing malformed multisend deployment-version lookup failures to deterministic "deployments not found" errors instead of leaking upstream parser exceptions.
- Expanding safe transaction parser coverage across Safe methods (`execTransaction*`, `approveHash`, `setup`) and adding additional fail-fast assertions in deployment transaction utilities.
- Hardening Safe call transaction-data construction with boundary validation for payload/object shape, target address validity, calldata hex normalization, and deterministic unsigned-integer value serialization errors for malformed runtime inputs.
- Canonicalizing Safe call target addresses to checksum format during shared call transaction-data normalization for deterministic downstream payloads.
- Validating optional Safe transaction nonce inputs as non-negative safe integers before forwarding create-transaction requests to Safe SDK.
- Validating Safe transaction-create inputs at runtime, including list shape/length metadata and `onlyCalls` flag type, to fail fast on hostile payloads before Safe SDK invocation.
- Requiring non-empty Safe transaction-create call lists to fail fast before Safe SDK invocation on empty payload batches.
- Hardening Safe transaction-create helper to validate Safe SDK shape and `createTransaction` accessibility/type before invocation, with deterministic boundary errors.
- Validating Safe transaction-create list entries (inaccessible/non-object) to fail fast on hostile transaction arrays before Safe SDK invocation.
- Normalizing Safe transaction-create call failures and validating returned Safe transaction object shape for deterministic boundary behavior.
- Hardening Safe transaction-create return validation by failing closed on inaccessible return payload fields and non-object return transaction data.
- Validating and normalizing each Safe transaction-create list entry via shared call-data parser before SDK invocation, including deterministic invalid-call payload errors.
- Hardening Safe transaction proposal helper boundaries (Safe SDK/service/signer object shape, Safe tx hash/signature/address validation, inaccessible payload guards, and deterministic proposal failure messaging).
- Validating Safe proposal payload transaction data shape (`to`/`data`/`value`) before service submission with deterministic invalid-payload errors.
- Canonicalizing Safe proposal submission addresses (`safeAddress`, transaction `to`, signer address) and transaction calldata casing before service submission.
- Validating and canonicalizing Safe proposal sender signatures as hex before service submission.
- Rejecting whitespace-only Safe proposal sender signatures with deterministic non-empty validation errors.
- Validating and canonicalizing Safe proposal transaction hashes before service submission and proposal logging.
- Hardening Safe proposal payload normalization to fail closed when hostile payload fields throw during normalization/spread.
- Hardening Safe proposal signer validation to fail closed when signer `getAddress` accessors are inaccessible.
- Hardening Safe signer resolution boundaries by validating signer-provider lookup/runtime shape, inaccessible private-key accessors, and deterministic signer-address resolution failures.
- Hardening Safe signer resolution with inaccessible `getAddress` accessor guards and canonicalized fallback signer-address outputs.
- Validating and canonicalizing Safe signer private-key fallbacks as 32-byte hex values.
- Validating and canonicalizing explicit Safe signer string inputs (address/private-key forms) with deterministic invalid-signer errors.
- Trimming surrounding whitespace on explicit Safe signer string inputs before address/private-key validation.
- Requiring typed-data signer support before Safe tx deletion.
