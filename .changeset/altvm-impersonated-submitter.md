---
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
---

Added a VM-agnostic impersonated submitter so `warp apply` can apply owner-authorized governance transactions against a fork without holding the real authority key.

- Added `SvmImpersonatingSigner` (exported as `SealevelImpersonatingSigner`) to `@hyperlane-xyz/sealevel-sdk`: it partially signs with only the held fee payer, leaves the remaining required signature slots empty, and submits with preflight disabled, relying on a fork's skip-signature-verification. The Sealevel transaction submission pipeline (build, blockhash retry, ALT resolution, confirmation, meta fetch) was extracted into a shared module that both `SvmSigner` and `SvmImpersonatingSigner` reuse; `SvmSigner` behavior is unchanged.
- Added an optional `createImpersonatingSigner` method to the `ProtocolProvider` interface in `@hyperlane-xyz/provider-sdk`, implemented for Sealevel. Protocols without fork tooling do not implement it, and impersonated submission on such a protocol throws a clear error.
- Added `AltVMImpersonatedSubmitter` to `@hyperlane-xyz/deploy-sdk`, which drives an impersonating signer and mirrors the EVM `EV5ImpersonatedAccountTxSubmitter`.
- Made `userAddress` optional on the `impersonatedAccount` submitter strategy schema in `@hyperlane-xyz/sdk` so AltVM chains can reuse the strategy key without an EVM address. EVM impersonation still asserts `userAddress` is present at submission time.
- Wired the `impersonatedAccount` submitter into the CLI AltVM submitter factories. The CLI builds an impersonating signer only for chains whose submission strategy selects `impersonatedAccount`.
