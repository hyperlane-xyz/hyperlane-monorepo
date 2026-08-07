# Lane-addressed Piecewise Fee Publisher

The Moonpay publisher updates signed piecewise fee curves without modifying
Warp deployment configuration. Its version 2 config addresses each update as a
lane:

```yaml
version: 2
lanes:
  - id: bsc-usdt-arbitrum-usdc
    origin: bsc
    sourceRouteId: USDT/moonpay-staging
    destination: arbitrum
    targetRouteId: USDC/moonpay-staging
    standing:
      breakpoints: ['100000', '250000']
      marginalBps: [2, 6, 12]
      ttl: 60s
      staleAfter: 12s
      staleMarginalSurchargeBps: [2, 4, 8]
    fallback:
      breakpoints: ['100000', '250000']
      marginalBps: [4, 10, 20]
```

`sourceRouteId` selects exactly one source Warp router on `origin`.
`targetRouteId` selects exactly one target Warp router on `destination`. The
publisher reads the source router's fee root and resolves only the explicit
`(destination, target router)` leaf. It fails if the route token, routing root,
explicit leaf, or expected piecewise fee type is absent. It never scans or
updates sibling/default leaves.

Breakpoints are human token units. The publisher scales them with the fee
token decimals read from the resolved piecewise contract. Fallback is required;
standing is optional.

## Usage

Run from `typescript/infra`. Commands are dry runs unless `--submit` is set:

```bash
pnpm tsx scripts/moonpay/set-curves.ts --mode standing
pnpm tsx scripts/moonpay/set-curves.ts --mode fallback
```

Select lanes by repeating `--lane`:

```bash
pnpm tsx scripts/moonpay/set-curves.ts \
  --mode standing \
  --lane bsc-usdt-arbitrum-usdc
```

To send the displayed transactions:

```bash
pnpm tsx scripts/moonpay/set-curves.ts \
  --mode standing \
  --lane bsc-usdt-arbitrum-usdc \
  --submit
```

The publisher uses the latest origin block timestamp as `issuedAt`, binds each
signature to the transaction submitter, and sends one curve update per
transaction. Identical lanes resolving to the same update target are
deduplicated; conflicting policies for one target are rejected.

The checked-in values are staging fixtures, not production recommendations.
Changing these operational values does not change Warp getters or deployment
topology.
