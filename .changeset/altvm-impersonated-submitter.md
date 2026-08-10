---
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/cli': minor
---

Added a keyless VM-agnostic impersonated submitter so `warp apply` can apply owner-authorized governance transactions against a fork without holding the authority key.

- Added `SvmImpersonatingSigner` (exported as `SealevelImpersonatingSigner`) to `@hyperlane-xyz/sealevel-sdk`: it pays fees from a fixed, public, fork-only fee payer and leaves the impersonated owner's signature slot empty, relying on a fork's disabled signature verification. `SvmForkManager` airdrops the fork fee payer at boot. The Sealevel signer internals were refactored into a shared `BaseSvmSigner` base class that both `SvmSigner` and `SvmImpersonatingSigner` extend; `SvmSigner` behavior is unchanged.
- Relocated the protocol-agnostic `AltVMJsonRpcSubmitter` and `AltVMImpersonatedSubmitter` into `@hyperlane-xyz/provider-sdk` (browser-safe) and added an `impersonatedAccount` variant to the transaction submitter configs; `@hyperlane-xyz/deploy-sdk` re-exports them for backwards compatibility.
- Implemented `createSubmitter` for Sealevel (`jsonRpc` and `impersonatedAccount`); impersonated submission builds the keyless signer with no private key.
- Wired the `impersonatedAccount` submitter into the CLI AltVM submitter factories, dispatched through `createSubmitter`.
