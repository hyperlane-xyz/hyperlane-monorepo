# Signed Piecewise Warp Fee Curves

## Decision

Add an EVM `OffchainQuotedPiecewiseLinearFee` for Warp Routes. An authorized
signer publishes a reusable marginal fee curve for a destination and optional
recipient. A normal curve widens once as it ages, expires, and then resolves to
a required permanent piecewise fallback.

This design is stateless per transfer. It prices transfer size and quote age,
but does not reserve inventory, consume a band, or couple a market observation
to transaction inclusion.

## Marginal amount bands

Amount ranges are marginal tranches, not whole-order buckets. With breakpoints
`[100,000, 250,000]` and rates `[2, 6, 12]` bps:

| Transfer | Fee calculation                                     | Fee |
| -------- | --------------------------------------------------- | --: |
| 100,000  | 100,000 x 2 bps                                     |  20 |
| 200,000  | 100,000 x 2 bps + 100,000 x 6 bps                   |  80 |
| 300,000  | 100,000 x 2 bps + 150,000 x 6 bps + 50,000 x 12 bps | 170 |

The final rate is open-ended. Breakpoints must be positive and strictly
increasing. Marginal rates must be nondecreasing. A zero-rate normal curve is
valid, but the permanent fallback must contain at least one positive rate.

The curve is stateless. Several smaller transfers can repeatedly use its cheap
first band. Stateful capacity or inventory consumption is a separate contract
design.

## Quote-age widening

A standing quote grants the user an option: execute when the published price is
favorable and ignore it otherwise. Updating every block reduces this exposure
but does not remove market movement between publication and execution.

Each normal curve therefore carries one age threshold and one surcharge per
size band:

```text
fresh marginal rate[i] = marginalBpsX1e4[i]
stale marginal rate[i] =
    marginalBpsX1e4[i] + staleMarginalSurchargeBpsX1e4[i]
```

For example:

```text
breakpoints       = [100,000, 250,000]
fresh rates       = [2, 6, 12] bps
stale surcharges  = [2, 4, 8] bps
stale rates       = [4, 10, 20] bps
```

The stale surcharge is discrete, not continuous. The contract uses block
timestamp and treats the curve as stale when:

```solidity
block.timestamp >= uint256(issuedAt) + staleAfterSeconds
```

The normal curve remains valid at its exact expiry timestamp and becomes
unavailable when `block.timestamp > expiry`. Consequently a curve can use its
stale rates at exact expiry, with fallback beginning in the first later block.

## Wire formats

The signed context remains packed as:

```text
[0:4]    destination (uint32)
[4:36]   recipient (bytes32)
[36:68]  amount (uint256)
```

A transient quote keeps the existing capped-linear format:

```solidity
abi.encodePacked(uint256 maxFee, uint256 halfAmount)
```

A normal standing quote uses:

```solidity
abi.encode(
    uint128[] breakpoints,
    uint32[] marginalBpsX1e4,
    uint32 staleAfterSeconds,
    uint32[] staleMarginalSurchargeBpsX1e4
)
```

One basis point is encoded as `10_000`; 10,000 bps is `100_000_000`.
Breakpoints use the source token's local atomic units.

Validation requires:

- one more rate than breakpoint;
- at most the immutable `maxBands` deployment limit;
- nondecreasing base rates and stale surcharges;
- every base-plus-surcharge rate at or below 10,000 bps;
- `staleAfterSeconds > 0`; and
- `issuedAt + staleAfterSeconds <= expiry`.

Submission precomputes fresh and complete stale weighted prefixes. Quoting
selects one curve and performs one rounded calculation; it does not add two
separately rounded fees. Eight fixed binary-lifting probes support up to 256
bands without looping over the active curve in the transfer path.

## Permanent mutable fallback

Deployment requires a valid piecewise fallback:

```solidity
constructor(
    address quoteSigner,
    address feeToken,
    uint128[] memory fallbackBreakpoints,
    uint32[] memory fallbackMarginalBpsX1e4,
    uint16 maxBands,
    address owner
)
```

The fallback:

- is contract-global;
- does not expire or widen with age;
- may be a one-rate constant-bps curve or a multi-band curve;
- rejects an all-zero rate vector; and
- remains active until an authorized quote signer replaces it.

Fallback replacement uses a separate EIP-712 message:

```solidity
struct SignedFallbackCurve {
    bytes data; // abi.encode(uint128[], uint32[])
    uint48 issuedAt;
    address submitter;
}
```

The signature has no submission deadline. It is bound to a nonzero transaction
submitter, cannot be future-dated, and is ordered by `issuedAt`. An identical
equal-timestamp retry is a no-op; different state at the same timestamp reverts.
An older signed update remains submit-able by its bound operator until a newer
fallback has been installed.

Removing a quote signer prevents new signatures from that signer from being
accepted. It does not invalidate the already installed fallback or unexpired
normal curves.

## Resolution

Fee resolution remains:

1. Matching transient quote.
2. Exact destination and recipient normal curve.
3. Destination and wildcard recipient.
4. Wildcard destination and exact recipient.
5. Permanent fallback curve.

An expired higher-priority curve continues through the lower-priority wildcard
scopes before reaching fallback.

No caller ABI changes are required for `quoteTransferRemote` or
`transferRemote`. Interchain gas payment remains a separate quote.

## Configuration lifecycle

Deployment config uses atomic token units and calls the required curve
`initialFallback`. Contract readers expose current signer-managed state as
`fallbackCurve` with its latest `issuedAt`.

Changing `initialFallback` in declarative config after deployment never causes
a redeployment. Operators use the signed curve publisher. The immutable
`maxBands` cap, fee token, or contract type still require a new leaf contract;
owner and quote-signer changes remain ordinary owner transactions.

Publishing and route-specific rollout configuration are separate operational
concerns. This contract does not add transfer maximum-fee/deadline parameters,
onchain derivation from rebalance inputs, or persistent band consumption.
