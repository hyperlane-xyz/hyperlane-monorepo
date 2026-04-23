# DelayedFlowRouter

Amount-sensitive hook + ISM that pairs with a warp route to slow cross-chain
withdrawals when net flow on the paired pool exceeds a configurable fraction.
Designed to mitigate bridge-compromise scenarios (e.g. LayerZero rsETH) while
leaving normal, small-amount flow instant.

## Key properties

- **Capacity is live.** `maxCapacity() = pool × thresholdBps / BPS` reads the
  paired warp router's balance (native) / `balanceOf` (collateral) /
  `totalSupply` (synthetic) at call time. Not snapshotted.
- **Refill derives from capacity.** Tokens refill at `maxCapacity / DURATION`
  per second. Subclasses that override `maxCapacity()` get a matching refill
  rate automatically.
- **Delay is sized at preverify.** When the preverify message lands on the
  destination, the bucket is consumed against current pool state. The
  resulting `wait` is clamped to `maxDelay` and written to `readyAt[id]`.
- **`verify` is a pure read.** The ISM never recomputes capacity at verify
  time — `readyAt` was committed at preverify and is immutable from then on.
  First-come-first-served on the bucket, with a bounded UX worst-case.
- **Deposits credit 1:1.** Local outbound dispatches credit the bucket (up to
  `maxCapacity`), preserving net-zero-flow UX for rebalancers and two-way
  fee traffic.

## Lifecycle

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant SR as Synthetic Router<br/>(origin)
  participant OD as origin<br/>DelayedFlowRouter
  participant OM as Origin Mailbox
  participant DM as Dest Mailbox
  participant DD as destination<br/>DelayedFlowRouter
  participant CR as Collateral Router<br/>(destination)

  Note over U,CR: maxCapacity() = pool × thresholdBps / BPS (always read live)

  U->>SR: transferRemote(dest, to, amount)
  SR->>SR: burn synthetic (totalSupply ↓)
  SR->>OM: dispatch(warp)
  OM-->>OD: postDispatch(warp)
  Note over OD: sender == warpRouter<br/>nonce > lastCreditedNonce<br/>_credit(amount): bucket ← min(cap, bucket + amount)
  OD->>OM: dispatch(preverify = id, amount)

  Note over OM,DM: cross-chain delivery — preverify & warp<br/>arrive independently

  DM-->>DD: handle(preverify)
  Note over DD: maxCapacity() read NOW<br/>(pre-withdrawal pool)<br/>_consume(amount):<br/>  level = levelAtCap<br/>  deficit = (amount - level) × DURATION / cap<br/>  wait = min(deficit, maxDelay)
  Note over DD: commit readyAt[id]

  DM->>CR: process(warp)
  CR->>DD: verify(warp)
  alt block.timestamp < readyAt[id]
    DD-->>CR: revert MessageNotReadyUntil
    Note over CR: relayer retries later
  else ready
    DD-->>CR: true
    CR->>U: release(amount)
  end
```

## Composing with `PausableIsm`

Ordering matters inside `StaticAggregationIsm`: put `PausableIsm` **before**
`DelayedFlowRouter` so a paused state short-circuits the aggregation with
`Pausable: paused` rather than whatever the delay ISM would surface.

```
modules = [pausable, delayedFlowRouter]
threshold = 2
```

## Sender / recipient binding

- `postDispatch` requires `message.sender == warpRouter` — prevents a third
  party from dispatching an arbitrary message through the Mailbox and
  triggering a credit + preverify against the paired pool's bucket.
- `verify` requires `message.recipient == warpRouter` — prevents verifying
  messages that aren't destined for the paired warp route (e.g. a contract
  that configured us as its ISM).

## Replay protection

`postDispatch` tracks `lastCreditedNonce` (uint32) and requires
`message.nonce > lastCreditedNonce`. Combined with `TimelockRouter`'s
`_isLatestDispatched` check, this prevents the same message from
double-crediting the bucket or re-sending a preverify.
