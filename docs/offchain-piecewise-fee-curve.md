# Signed Piecewise Warp Fee Curves

## Decision

Add an EVM `OffchainQuotedPiecewiseLinearFee` for Warp Routes. An authorized
signer publishes a reusable marginal fee curve for a destination and optional
recipient. The contract preserves the existing signed-quote context, expiry,
wildcard resolution, transient overrides, and `LinearFee` fallback.

The first rollout is deliberately stateless. It improves pricing by transfer
size, but it does not reserve inventory or remove the time between observing
state and execution. Production curves therefore need a risk buffer.

## Current boundary

The Warp fee and interchain gas payment (IGP) are separate quotes:

- The Warp fee compensates the route operator for liquidity, inventory, and
  rebalancing risk.
- IGP pays for destination message execution. A direct integration obtains it
  separately from the Warp fee.
- An aggregator may present one all-in amount to its user, but the onchain
  components remain separate.

Signature-based pricing means an authorized account signs pricing state that a
contract verifies. A standing quote is reusable until expiry. A transient quote
is installed and consumed in the same transaction through `QuotedCalls`.

This differs from a traditional request for quote (RFQ). In an RFQ, a taker
reveals an exact pair, direction, and amount; a maker responds with a short-lived
firm price for that request. The proposed curve is standing liquidity: takers
choose when and how much to execute against it.

## Marginal amount bands

Amount ranges are marginal tranches, not whole-order buckets. With breakpoints
`[100,000, 250,000]` and marginal rates `[1, 4, 12]` bps:

| Transfer | Fee calculation                                    | Fee |
| -------- | -------------------------------------------------- | --: |
| 100,000  | 100,000 x 1 bp                                     |  10 |
| 200,000  | 100,000 x 1 bp + 100,000 x 4 bps                   |  50 |
| 300,000  | 100,000 x 1 bp + 150,000 x 4 bps + 50,000 x 12 bps | 130 |

The final rate is open-ended. Marginal rates must be nondecreasing, so the fee
is continuous and the incremental price never improves as an order gets larger.
Rates may be zero, but rebates and fixed token fees are not supported.

## Why a curve

A flat percentage makes a 1,000 token transfer and a 500,000 token transfer pay
the same marginal rate even though the latter can consume scarce destination
inventory and force an expensive rebalance. A marginal curve can keep ordinary
flow competitive while charging the tail for the risk it creates.

IGP being separate simplifies the curve: it need not approximate destination
execution gas. Rebalancing gas, bridge costs, inventory opportunity cost, and
market movement still belong in the Warp fee.

## Adverse selection

A standing curve grants the taker an option. The taker executes when the signed
price is favorable and ignores it when it is not. The maker is exposed between
the state observation used to produce the curve and the transfer's execution.

Example:

1. Base has 1,000,000 USDC, of which 700,000 is usable above reserves.
2. The maker publishes an Arbitrum-to-Base curve with a cheap first 100,000.
3. A 500,000 Ethereum-to-Base transfer consumes the same Base inventory.
4. Before the Arbitrum curve is replaced, an informed taker executes its cheap
   100,000 tranche.
5. If replacement liquidity now costs 12 bps and the stale curve charges 1 bp,
   the maker loses about 11 bps, or 110 USDC on that transfer.

A curve prices the expected cost of size. It does not see concurrent fills,
cross-origin inventory consumption, price moves, delayed rebalances, or chain
reorganizations after publication.

### Split orders

The curve is stateless per call. One 300,000 transfer under the example curve
costs 130, while three independent 100,000 transfers cost 30. Repeated gas and
IGP can make splitting less attractive, but they do not enforce aggregate
capacity and are especially weak on inexpensive origins.

The Q3 2026 audit found the analogous fragmentation problem in flow limiting.
That system required persistent debt accounting so splitting could not reset
the marginal state. The stateless fee curve intentionally does not add such
accounting in its first version.

### Mitigations in the first version

- Publish nondecreasing marginal rates with a wider tail buffer.
- Keep standing quote expiries short enough for the publisher's update cadence.
- Refresh after inventory, replacement cost, or market volatility moves.
- Fall back to an onchain linear rate when no standing quote is valid.
- Monitor curve age, inventory, realized rebalancing cost, fee revenue, and
  clustering of transfers just below breakpoints.
- Roll out on one staging origin before proposing production configuration.

These reduce expected loss; they do not eliminate the option. Without atomic
state-to-execution protection, persistent consumption, or protected order flow,
the signed rates need a buffer for the remaining window.

## Integration models

### Direct integrations

Existing callers continue to use `quoteTransferRemote` and
`transferRemote`/`transferRemoteTo`. No caller ABI changes. A standing curve is
resolved onchain; IGP remains a separate quote. `QuotedCalls` can atomically
install a transaction-scoped curve override before transferring.

### API-driven aggregators

[LI.FI](https://docs.li.fi/agents/reference/endpoint-specs) and
[Relay](https://docs.relay.link/references/api/get-quote-v2) accept an amount and
return executable routing data. They can quote the same Warp Route at the
requested amount and combine its fees with other route costs. This proposal does
not add an amount-specific Hyperlane API or change aggregator integration.

### Comparables

- [Across](https://docs.across.to/introduction/fees) uses utilization-sensitive
  pricing with a kink above which the rate rises more steeply. It is the closest
  economic analogue for charging more as liquidity becomes scarce.
- [Titan](https://docs.titanbuilder.xyz/) exposes fresh PropAMM state to quoting
  infrastructure. The open
  [LambdaClass PropAMM router](https://github.com/lambdaclass/propamm-router-contracts)
  requotes using Titan state overrides and can fall back to Uniswap. This reduces
  the stale-state window when the fresh state is available at execution, but it
  is not an assumption or dependency of the Warp fee curve.
- Smooth AMM-style functions can remove visible breakpoints. They do not solve
  stale state or split-order consumption and are deferred until there is data
  showing that piecewise operations are insufficient.

## Contract design

The signed context remains packed as:

```text
[0:4]    destination (uint32)
[4:36]   recipient (bytes32)
[36:68]  amount (uint256)
```

Curve data uses standard ABI encoding:

```solidity
abi.encode(uint128[] breakpoints, uint32[] marginalBpsX1e4)
```

One basis point is encoded as `10_000`, and 10,000 bps is encoded as
`100_000_000`. The denominator is therefore `100_000_000`. Breakpoints are in
the source token's local atomic units. On BSC Moonpay routes, local USDC and USDT
have 18 decimals; the router charges the fee before scaling the message amount
to 6 decimals.

Submission validates and precomputes cumulative weighted fees. Transfer quoting
uses a fixed eight-step binary-lifting lookup supporting at most 256 bands, so
the transfer path never loops over the configured curve. `maxBands` is immutable
per deployment; increasing it redeploys only the leaf fee contract.

Resolution is unchanged:

1. Matching transient quote.
2. Exact destination and recipient standing curve.
3. Destination and wildcard recipient.
4. Wildcard destination and exact recipient.
5. Immutable `LinearFee` fallback.

Standing curves require wildcard amount. Transient curves may bind an exact
amount or use the wildcard. Removing a signer does not invalidate an already
stored standing curve.

## Rollout stages

### Stage 1: contract and manual staging curves

- Deploy with `maxBands = 4` on BSC for both Moonpay staging routes.
- Configure a 3 bps linear fallback.
- Publish `[100,000, 250,000]` with `[1, 4, 12]` bps for every discovered
  destination and target-router slot.
- Verify direct, target-router, transient, expiry, and fallback paths.

The example is a staging test, not a production recommendation. The 3 bps
fallback preserves current configuration but may be less protective than the
tail and must be reconsidered for production.

### Stage 2: automated publishing

Build a service that derives curves from inventory, replacement paths, market
state, and volatility. Set TTL below the maximum tolerated stale-state window,
alert on curve age, and compare collected fees with realized rebalancing costs.
The pricing algorithm is outside Stage 1.

### Stage 3: stronger execution protection

If splitting or concurrent consumption is material, add stateful per-origin or
shared capacity accounting, or use an execution environment that couples fresh
state with inclusion. This is a separate contract and audit decision because it
adds writes to the transfer path.

### Stage 4: RFQ/API products

An amount-specific API can serve direct takers or aggregators with shorter-lived
transient quotes. It is optional and does not block standing curves.

## Production gate

Production configuration is proposed only after BSC staging shows:

- Onchain fees match the offchain reference at and around every breakpoint.
- Direct and `QuotedCalls` paths work for USDC and USDT target slots.
- Expired curves reliably resolve to fallback.
- No unhandled quote or transfer reverts during a seven-day soak.
- Nam and the route operator approve the production fallback, curve parameters,
  publisher cadence, monitoring, and canary origin.
