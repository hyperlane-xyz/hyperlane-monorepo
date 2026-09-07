---
'@hyperlane-xyz/core': minor
---

Add `AxelarHook` and `AxelarIsm` for transporting Hyperlane message IDs over
Axelar's General Message Passing (GMP). The hook calls `IAxelarGateway.callContract`
and pre-pays the Axelar Gas Service in native tokens (over-paying, with the
surplus refunded by Axelar to the metadata refund address); the ISM inherits
`AxelarExecutable` and authorizes deliveries by validated Axelar source chain
and source address before recording verification via `preVerifyMessage`. Closes #2851.
