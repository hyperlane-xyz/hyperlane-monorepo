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
      breakpoints: ['0.25', '0.75']
      marginalBps: [2, 6, 12]
      ttl: 60s
      staleAfter: 12s
      staleMarginalSurchargeBps: [2, 4, 8]
    fallback:
      breakpoints: ['0.25', '0.75']
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

## Production fallback template

`moonpay-production-piecewise.yaml` contains the seven remote
`BSC USDT -> USDC` production lanes: Arbitrum, Base, Citrea, Ethereum, Katana,
Polygon, and Solana. Each lane starts with a flat 3 bps mutable fallback and
has no standing curve. The same-domain BSC USDC target, all USDT targets, and
every destination default remain on the existing 3 bps quoted-linear fee.

The production file is an operational template for fork validation and future
fallback updates. It does not authorize a production write. Preview all seven
fallback updates with:

```bash
pnpm tsx scripts/moonpay/set-curves.ts \
  --config config/environments/mainnet3/warp/fees/moonpay-production-piecewise.yaml \
  --mode fallback
```

The publisher accepts the Solana target router as a 32-byte Sealevel address;
the source router remains the EVM BSC router. No production curve submission
is part of the staging rollout.

The production topology can be applied only to a local BSC fork with the
guarded harness. Its default invocation is a zero-write preview; its write path
requires both `--apply` and `--fork`, impersonates the fee-owner ICA locally,
and has no live mode:

```bash
pnpm tsx scripts/moonpay/deploy-production-piecewise-fee-fork.ts

anvil --fork-url "$RPC_URL_BSC" --block-time 1
pnpm tsx scripts/moonpay/deploy-production-piecewise-fee-fork.ts \
  --apply --fork
```

Fork validation requires the production BSC router and existing fee root to
match their guarded snapshot. It verifies seven distinct piecewise leaves and
also verifies that the router continues pointing at its existing routing root.

## Guarded staging lifecycle

`run-piecewise-lifecycle.ts` is locked to the checked-in
`bsc-usdt-arbitrum-usdc` staging lane. It exercises four 1e18 transfers to the
explicit Arbitrum USDC router:

The staging breakpoints are deliberately compressed to 0.25 and 0.75 USDT, so
each 1-USDT transfer crosses both breakpoints and consumes all three marginal
bands. The harness rejects a lifecycle curve whose final breakpoint is not
below the transfer amount.

1. fallback, after any existing standing curve has expired;
2. fresh, immediately after publishing the configured standing curve;
3. stale, after the BSC block timestamp reaches `issuedAt + staleAfter`;
4. expired, after the BSC block timestamp is greater than `expiry`.

The script checks the effective fee at every phase and requires the BSC USDT
balance of the routing fee root to increase by that fee after each transfer.
It polls BSC block timestamps rather than local wall-clock time. Token approval
is bounded to 5e18 across the four transfers and revoked in a `finally` block.

The default invocation is read-only. It discovers and prints the exact routers,
checks the fallback curve, and quotes the current state without loading GCP
keys, approving tokens, publishing a curve, waiting, or transferring:

```bash
pnpm tsx scripts/moonpay/run-piecewise-lifecycle.ts \
  --recipient <ARBITRUM_RECIPIENT>
```

Submission additionally requires both discovered router addresses to be copied
back exactly. Only this path loads the GCP quote signer and deployer:

```bash
pnpm tsx scripts/moonpay/run-piecewise-lifecycle.ts \
  --recipient <ARBITRUM_RECIPIENT> \
  --submit \
  --confirm-source-router <DISCOVERED_BSC_USDT_ROUTER> \
  --confirm-target-router <DISCOVERED_ARBITRUM_USDC_ROUTER>
```

This is an operator-run staging harness, not a production transfer loop.
