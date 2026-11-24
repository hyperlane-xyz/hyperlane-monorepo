---
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/cli': minor
'@hyperlane-xyz/metrics': patch
---

Routers over Aevo xERC20 tokens were given a `TokenStandard` of their own, `EvmHypAevoXERC20`, which broke an exhaustive `Record<TokenStandard, ...>` or `switch` over it, and an SDK without it did not parse a route config that carries it. `EvmHypAevoXERC20Adapter` reported the limits of such a router like those of any other xERC20 router, from its authority, its cap and the amount it had minted and not burned, which it read through the undocumented getter behind the exported `AEVO_OUTSTANDING_SELECTOR`. What the router had bridged was that amount, not the supply of the token. An Aevo router needed no approval of its token for itself from the sender, as the burn of the token took no allowance.

`warp deploy` and a `warp apply` that adds a chain wrote the standard of each EVM xERC20 router from its token, as the exported `deriveEvmXERC20Standard` gave it: `EvmHypAevoXERC20` for an Aevo token, and `EvmHypVSXERC20` for a Velodrome token, which was written as `EvmHypXERC20` before. For a re-exported Velodrome route, `WarpCore` and the rebalancer then limited a transfer to half of the buffer cap of its router, and its balance and limits metrics were labelled `EvmHypVSXERC20` where they were labelled `xERC20` and `EvmHypXERC20`, with the router as the `wallet_address` of its balance metric in place of the xERC20 token.

`warp read` logged the limits of an Aevo router in the same table as the other xERC20 routers, and `getXERC20Info` of `@hyperlane-xyz/metrics` read an Aevo token through its adapter.
