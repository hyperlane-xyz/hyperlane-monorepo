---
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/cli': minor
---

Added a keyless VM-agnostic impersonated submitter so `warp apply` can apply owner-authorized governance transactions against a fork without holding the authority key.

- Added `SvmImpersonatingSigner` (exported as `SealevelImpersonatingSigner`) to `@hyperlane-xyz/sealevel-sdk`: it pays fees from a fixed public fork-only account and leaves the impersonated account's signature slot empty, which only a skip-signature-verification fork accepts. It is scoped to the configured `userAddress` — every unsigned required-signer slot must belong to that account, so it is not an unrestricted signature bypass. Sealevel signer internals moved to a shared `BaseSvmSigner`; `SvmSigner` behavior is unchanged.
- Relocated `AltVMJsonRpcSubmitter` and `AltVMImpersonatedSubmitter` into `@hyperlane-xyz/provider-sdk` (browser-safe) as sibling subclasses of a shared base, and added an `impersonatedAccount` submitter config variant. `@hyperlane-xyz/deploy-sdk` re-exports `AltVMJsonRpcSubmitter` for backwards compatibility.
- Implemented `createSubmitter` for Sealevel (`jsonRpc` and `impersonatedAccount`) and wired the `impersonatedAccount` submitter into the CLI AltVM submitter factories.
