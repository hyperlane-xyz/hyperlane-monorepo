# Relay inventory transfers

Select `externalBridge: relay` on an inventory route and configure:

```yaml
externalBridges:
  relay:
    defaultSlippage: 0.001
    maxQuoteLossBps: 100
```

The defaults allow 0.1% slippage within a 1% total nominal token-loss budget.
The minimum destination amount, after all quoted fees and slippage, must meet
that budget. Source and destination decimals are read on chain. This comparison
is intended for equivalent collateral such as USDC across chains, not unrelated
assets with different prices. Source gas is paid separately in the native asset.

The adapter supports EVM ERC20 exact-input and exact-output quotes. It rejects
native tokens, signature/permit flows, deposit addresses, multiple deposit
transactions, changed chains/tokens/recipients, and nonzero native call value.
It uses bounded exact ERC20 approvals and refreshes the quote after approval.
A refresh cannot increase the accepted input or lower the accepted minimum.
The provider's calldata remains inside the accepted inventory-key trust boundary;
the adapter does not simulate or decode arbitrary execution semantics.

Set optional `RELAY_API_KEY` for authenticated quotes and status requests. Keys
are sent in headers only. `/quote/v2` and `/intents/status/v3` work without a key.
Relay currently requires a key for `/requests/v3`; settlement does not depend on
that endpoint. Instead, the request ID and expected transfer fields are recorded
through `onTransferId` before source broadcast and retained by the existing
in-memory action tracker. No durable execution store is introduced.

Only Relay `success` plus finalized source and destination receipts can complete
an action. Receipt checks bind the source sender and token debit to the request,
and verify the actual destination ERC20 credit to the intended recipient.
`failure` is not terminal: Relay can still retry or refund. A refund becomes a
failed action only after an origin-chain refund receipt credits the source token.
`refundFailReason` produces a manual-recovery diagnostic while preserving the
reservation. Missing transfer identity also requires manual reconciliation.

References:

- [Quote API](https://docs.relay.link/references/api/get-quote-v2)
- [Status semantics](https://docs.relay.link/references/api/get-intents-status-v3)
- [Fee structure](https://docs.relay.link/references/api/api_core_concepts/fees)
