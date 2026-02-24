# Solana Artifact API Review Findings (`typescript/svm-provider`)

Context reviewed:

- `@solana/kit` docs in:
  - `~/solana/kit/docs/content/docs/getting-started/*`
  - `~/solana/kit/docs/content/docs/concepts/{codecs,keypairs,rpc,signers,transactions}.mdx`
- SVM Artifact API implementation in `typescript/svm-provider`

This document focuses on implementation correctness and usage patterns relative to Kit APIs and documented conventions.

## 1) `readHook(address)` is not address-correct for IGP

### What

`SvmHookArtifactManager.readHook(address)` detects the type from the provided `address`, but then constructs readers from **configured program addresses**, not from the input address.

- `typescript/svm-provider/src/hook/hook-artifact-manager.ts:42`
- `typescript/svm-provider/src/hook/hook-artifact-manager.ts:46`
- `typescript/svm-provider/src/hook/hook-artifact-manager.ts:62`

For IGP specifically:

- type detection assumes input is an IGP program id (`fetchIgpProgramData(rpc, address)`):
  - `typescript/svm-provider/src/hook/hook-query.ts:76`
  - `typescript/svm-provider/src/hook/hook-query.ts:80`
- reader ignores its `read(address)` parameter entirely and reads by constructor `programId + salt`:
  - `typescript/svm-provider/src/hook/igp-hook.ts:62`

### Why it matters

The Artifact interface contract is `read(address)` for a specific on-chain artifact. Current behavior for IGP is effectively "read configured IGP for this manager" rather than "read this address". That can produce wrong reads if caller passes a different deployed hook address, and makes behavior inconsistent between hook types.
This diverges from Kit’s explicit-address pattern (`address(...)`-typed inputs passed through fetch/tx builders), where helper functions are expected to act on the provided address rather than hidden manager defaults.

## 2) Hook type detection has a hard default to Merkle

### What

`detectHookType` returns Merkle whenever IGP program-data probe is null.

- `typescript/svm-provider/src/hook/hook-query.ts:84`

### Why it matters

This is not a positive Merkle identification; it is a fallback classification. For unknown/invalid addresses this can silently misclassify as Merkle and then return a synthesized artifact from mailbox defaults. That weakens failure semantics and can mask integration issues.
Kit patterns prefer explicit assertions/guards over silent fallbacks (e.g., assert-style helpers around account existence and transaction validity), so unknown addresses should fail clearly instead of defaulting to another hook type.

## 3) Tx send/confirm flow bypasses Kit’s recommended helper path

### What

`createSigner().send(...)`:

- manually serializes (`getBase64EncodedWireTransaction`)
- sends via raw RPC
- uses `skipPreflight: true`
- polls `getSignatureStatuses`

- `typescript/svm-provider/src/signer.ts:77`
- `typescript/svm-provider/src/signer.ts:80`
- `typescript/svm-provider/src/signer.ts:89`

### Why it matters

Kit docs recommend using send-and-confirm factories for blockhash-lifetime txs, combining RPC + subscriptions for robust confirmation semantics. Current implementation can be less reliable under congestion/expiry and preflight skipping by default removes an important failure signal.
Recommended Kit path is:

- build/sign via signer-aware transaction message flow (`setTransactionMessageFeePayerSigner`, `setTransactionMessageLifetimeUsingBlockhash`, `signTransactionMessageWithSigners`)
- send/confirm via `sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })` (or `sendTransactionWithoutConfirmingFactory` when confirmation is intentionally externalized)

## 4) `additionalSigners` is declared and passed, but not applied

### What

`SvmTransaction` includes `additionalSigners?: TransactionSigner[]`:

- `typescript/svm-provider/src/types.ts:17`

Deploy test passes it:

- `typescript/svm-provider/src/tests/deploy.e2e-test.ts:97`

But `send(...)` never uses it in message construction/signing:

- `typescript/svm-provider/src/signer.ts:65`
- `typescript/svm-provider/src/signer.ts:73`

### Why it matters

This is an API footgun: callers can reasonably expect additional signers to participate. Hidden non-use is worse than absence because it fails expectations silently.

## 5) Address handling relies heavily on unchecked casts

### What

Many `string -> Address` transitions are done with `as Address` rather than validated conversion/decoding.

Examples:

- `typescript/svm-provider/src/hook/hook-artifact-manager.ts:43`
- `typescript/svm-provider/src/ism/ism-artifact-manager.ts:41`
- `typescript/svm-provider/src/hook/igp-hook.ts:157`

### Why it matters

Kit’s type model around `Address` is intended to prevent invalid address strings from flowing through transaction/account APIs. Unchecked casts weaken those guarantees and can defer failures to deeper RPC/program errors.
Recommended pattern is to normalize/validate at boundaries and keep `Address` typed values throughout (e.g., using Kit address codecs/helpers such as `getAddressEncoder`/`getAddressDecoder`, and avoiding `as Address` for unchecked user/config strings).

## 6) `fetchAccount` wrapper erases Kit’s Maybe-account shape

### What

`fetchAccount` returns `EncodedAccount | null` by collapsing `MaybeEncodedAccount.exists`.

- `typescript/svm-provider/src/rpc.ts:15`
- `typescript/svm-provider/src/rpc.ts:23`

### Why it matters

Kit docs emphasize `MaybeEncodedAccount` for explicit existence handling and better type narrowing. Collapsing to `null` loses that uniform pattern and makes downstream account handling less expressive.
Recommended usage is to keep `fetchEncodedAccount`/`fetchEncodedAccounts` return shapes (`MaybeEncodedAccount`) and use explicit branch/assert helpers (`exists` checks, `assertAccountExists`) at call sites.

## 7) Merkle reader can return synthetic deployment address from empty input

### What

Merkle reader returns:

- `deployed.address = address || mailboxAddress`

- `typescript/svm-provider/src/hook/merkle-tree-hook.ts:34`

### Why it matters

Even if caller passes an empty/invalid input string, reader can still return a successful artifact using mailbox fallback. That weakens invariants around identity of the artifact being read.

## 8) Test coverage currently reinforces config-bound behavior

### What

Current Hook Artifact Manager test checks Merkle detection via mailbox address only:

- `typescript/svm-provider/src/tests/hook.e2e-test.ts:223`

No test asserts reading IGP by arbitrary deployed hook address path.

### Why it matters

The current suite does not pressure-test address-driven read semantics and therefore may miss regressions in Artifact API contract adherence.

---

## Summary

Primary concern is API contract correctness around `read(address)` and address/type handling in hook artifact logic. Secondary concern is tx send/confirm behavior diverging from documented Kit patterns and exposing hidden reliability risks. Additional concerns are API clarity (`additionalSigners`) and type-safety erosion (`as Address`, Maybe-account collapse).
