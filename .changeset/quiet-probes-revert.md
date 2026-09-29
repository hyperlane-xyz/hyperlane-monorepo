---
'@hyperlane-xyz/sdk': patch
---

The EVM warp route reader was made reliable for non-standard routers:

- The xERC20 probe treats a data-carrying revert (e.g. Fluent `Panic`) as "not xERC20".
- `feeRecipient()` is only read for routers with the token fee interface, and `feeHook()` and the legacy `scale()` are skipped when the router bytecode lacks the selector.
- SmartProvider keeps an empty-response error as the cause when another provider times out, so missing-selector handling no longer depends on provider latency.
- Missing-selector detection no longer classifies RPC transport failures (HTTP errors, dropped connections, `header not found`) as an absent selector.
