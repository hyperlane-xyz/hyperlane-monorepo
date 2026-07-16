---
"@hyperlane-xyz/sdk": patch
---

`HyperlaneJsonRpcProvider` stopped treating a bare `"0x"` `eth_call` result as an invalid provider response, since empty return data is a normal, spec-compliant result rather than a sign of a broken RPC. This was causing `SmartProvider` to exhaust all RPCs and throw a misleading "All providers failed" error, which broke `warp read`/`warp check` on routes with a legacy `InterchainGasPaymaster`. `EvmTokenAdapter.isApproveRequired`/`isRevokeApprovalRequired` were also hardened to normalize the `allowance()` result through `BigNumber.from()` before comparing it, avoiding a `TypeError` when a substituted provider returned a non-`BigNumber` value.
