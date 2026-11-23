# Solana fee limits and unsigned sampling

The swaps.xyz bridge prices the exact refreshed transaction with
`getFeeForMessage` before signing. The provider can choose a dynamic priority
fee, but the result must fit `maxSolanaTransactionFeeLamports` (default
10,000,000 lamports, 0.01 SOL on Solana). Above
`solanaTransactionFeeWarningLamports` (default 1,000,000 lamports, 0.001 SOL),
the bridge logs a warning; that warning does not block execution.

The existing `maxSolanaNativeSpendLamports` (default 10,000,000) is a separate
allowance for rent and other native debits. Simulation must show a total signer
debit no larger than the quoted transaction fee plus that allowance. The fee
ceiling does not replace this account-effects check. Lamport units apply to the
configured Sealevel chain; SOL conversions above describe Solana mainnet.

An above-cap transaction is rejected before signing or source submission. The
bridge does not lower the provider's compute-unit price or raise the cap
automatically. Requote later or use another feasible route when network fees
exceed the ceiling. Never increase the ceiling solely because the provider
requested a higher fee.

These are provisional operational limits, not congestion guarantees. A small
historical sample of 20 signer-paid transactions observed 5,000–37,500 lamports;
only one was a complex bridge transaction, from a different provider. That
sample cannot establish a production percentile or justify tighter limits.

## Sample while monitor-only

`monitorOnly: true` does not call bridge preparation. Run this separate unsigned
preflight with the same public inventory address, assets, amounts, metadata and
swaps.xyz policy to collect fee samples without changing that service mode:

```sh
pnpm -C typescript/rebalancer exec tsx src/scripts/preflightSwapsXyz.ts \
  --request /path/to/request.json \
  --metadata /path/to/chains.json \
  --config /path/to/swapsxyz.json \
  --output /path/to/new-fee-sample.json
```

`SWAPSXYZ_API_KEY` supplies the provider API key. The script never loads a signing
key, approves tokens, submits transactions or registers transfers. RPC URLs in
`chains.json` may contain credentials; keep that input private. Metadata is a
JSON object keyed by chain name and must include source and destination chains.
Use the configured source's domain ID for Sealevel requests.

`request.json` contains public quote parameters, with exactly one positive
base-unit amount encoded as a string:

```json
{
  "fromChain": 1399811149,
  "toChain": 1,
  "fromToken": "<source mint>",
  "toToken": "<destination token>",
  "fromAddress": "<public Solana inventory address>",
  "toAddress": "<destination recipient>",
  "fromAmount": "1000000"
}
```

`swapsxyz.json` contains the deployment's `externalBridges.swapsxyz` object,
including its economic policy and fee limits, for example:

```json
{
  "maxQuoteLossBps": 50,
  "defaultSlippage": 0.005,
  "maxSolanaTransactionFeeLamports": 10000000,
  "solanaTransactionFeeWarningLamports": 1000000,
  "maxSolanaNativeSpendLamports": 10000000
}
```

Use the real public inventory account: simulation still requires sufficient
balances and the provider's actual route prerequisites. A validated sample
records the transaction fee, simulated compute units and signer debit, policy
limits and RPC context slots. An above-cap fee is reported as rejected with
its observed fee and cap, before simulation. Other failures (including missing
balances or routes) are recorded as rejected, not successful fee samples. A
rejection exits nonzero. Output creation refuses to overwrite existing files
and uses owner-only permissions; it excludes raw payloads and RPC metadata.

Collect repeated samples at the actual configured trade sizes and during busy
periods before enabling execution. Review warnings, rejections and the separate
rent allowance together. Simulation observes current source state and does not
prove destination settlement or guarantee the state at later execution.
