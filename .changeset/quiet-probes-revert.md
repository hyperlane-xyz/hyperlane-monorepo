---
'@hyperlane-xyz/sdk': patch
---

The EVM warp route reader was made reliable for non-standard routers:

- The xERC20 probe treats a `Panic(uint256)` revert (e.g. Fluent) as "not xERC20"; other data-carrying reverts still propagate.
- Implementation bytecode is resolved for EIP-1967 proxies and EIP-1167 clones before selector checks; beacon proxies and failed reads yield unknown and are not cached.
- `feeRecipient()` is only read for routers with the token fee interface, and `feeHook()` and the legacy `scale()` are skipped when the router bytecode lacks the selector.
- SmartProvider keeps an empty-response error as the cause when another provider times out or returns a server error, so missing-selector handling no longer depends on provider latency.
- Missing-selector detection no longer classifies RPC transport failures (HTTP errors, dropped connections, `header not found`) as an absent selector, while Nethermind `-32015` reverts count as one.
