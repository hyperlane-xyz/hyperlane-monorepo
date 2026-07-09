---
"@hyperlane-xyz/sdk": minor
---

Add `AtomicLocalRebalancingBridge` as a deployable warp token type (`TokenType.atomicLocalRebalancing`). Like `TokenBridgeOft` and `TokenBridgeDepositAddress`, it is a bare `ITokenBridge` adapter deployed unproxied via the direct-deploy path (no proxy, no `initialize`, no remote enrollment or mailbox-client configuration). Its config schema carries the immutable `sourceRouter` the bridge binds to; the deployer supplies the constructor arguments `(localDomain, sourceRouter, owner)`, with `localDomain` derived from the chain. The type is registered in the token contract/factory maps and included in the warp-route "not synthetic-only" validation.
