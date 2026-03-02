# Flow-Reactive Rebalancing Strategies

## Motivation

Existing rebalancer strategies (Weighted, MinAmount, CollateralDeficit) are **snapshot-based** -- they look at current balances and compute routes. They have no awareness of _how_ balances are changing over time.

Flow-reactive strategies observe **recent transfer flow patterns** and use that velocity/trend information to decide rebalancing magnitude and direction. The goal: react earlier and more proportionally to emerging imbalances rather than waiting for them to become critical.

All four strategies share a common base class (`FlowReactiveBaseStrategy`) and operate on the same abstraction: given a time window of recent transfers, compute a set of `FlowSignal` values (chain, magnitude, direction) that drive rebalancing.

---

## Strategy 1: EMA Flow (Exponential Moving Average)

### Intent

Smooth out short-term noise and respond to the **sustained trend** of net flow per chain. If collateral has been steadily draining from a chain over the past N seconds, the EMA will reflect that trend and trigger a proportional rebalance.

### How It Works

```
ema_new = alpha * netFlow + (1 - alpha) * ema_previous
```

- `alpha` (0-1): Controls responsiveness. Higher alpha = faster reaction to new data, lower = more smoothing.
- `netFlow`: Sum of all flow records in the window (positive = collateral gained, negative = lost).
- The EMA value itself becomes the signal magnitude.

### When It Excels

- **Gradual ramps**: Steady increase in one-directional flow. The EMA tracks the trend faithfully.
- **Idle-then-spike**: During idle periods, EMA stays near zero and doesn't trigger unnecessary rebalances. When the spike hits, it ramps up.
- **Oscillating traffic**: The smoothing naturally dampens oscillations, preventing whiplash.

### When It Struggles

- **Burst spikes**: A sudden burst may not move the EMA enough on the first cycle if alpha is conservative. By the time EMA catches up, the damage may be done.
- **Sustained heavy drain**: With low alpha, the EMA lags behind the actual flow, causing under-reaction.

### Key Parameters

| Parameter             | Description                                     | Typical Value |
| --------------------- | ----------------------------------------------- | ------------- |
| `alpha`               | Smoothing factor (0-1). Higher = more reactive  | 0.3           |
| `windowSizeMs`        | Lookback window for flow records                | 5000          |
| `minSamplesForSignal` | Minimum flow records before generating a signal | 3             |
| `coldStartCycles`     | Polling cycles to skip before first signal      | 2             |

---

## Strategy 2: Velocity Flow (Rate of Change)

### Intent

React not just to the net flow but to **how fast** flow is happening. A 10 ETH drain over 30 seconds is less urgent than a 10 ETH drain over 2 seconds. The velocity component adds urgency scaling on top of a base response.

### How It Works

```
velocityBoost = (velocityMultiplier * FLOW_SCALE) / windowDuration
totalResponse = baseResponse + velocityBoost
magnitude = |netFlow| * totalResponse / FLOW_SCALE
```

- `baseResponse` (0-1): Minimum response factor regardless of velocity. A floor that guarantees some reaction.
- `velocityMultiplier` (0+): How much to amplify the velocity-derived boost. Higher = more aggressive on fast flows.
- The signal is **linear** in netFlow magnitude (unlike the original quadratic formula which was a bug).

### When It Excels

- **Burst spikes**: The velocity component fires hard when a sudden burst hits, producing larger rebalance amounts.
- **Sustained drain**: Steady flow rate keeps the velocity boost consistent, providing reliable response.

### When It Struggles

- **Oscillating traffic**: Rate of change is high in both directions during oscillations, potentially causing unnecessary signals (though balanced net flow mitigates this).
- **Very slow ramps**: Low velocity means the boost is minimal; response is mostly from `baseResponse` alone.

### Key Parameters

| Parameter             | Description                         | Typical Value |
| --------------------- | ----------------------------------- | ------------- |
| `velocityMultiplier`  | Amplification of velocity component | 1.0           |
| `baseResponse`        | Minimum response factor (0-1)       | 0.5           |
| `windowSizeMs`        | Lookback window                     | 5000          |
| `minSamplesForSignal` | Minimum samples required            | 3             |
| `coldStartCycles`     | Cold start skip cycles              | 2             |

---

## Strategy 3: Threshold Flow (Noise Filtering)

### Intent

Ignore small fluctuations and only respond when net flow exceeds a **noise threshold**. Once above the threshold, respond proportionally to the excess. This prevents the rebalancer from churning on balanced or low-volume traffic while still reacting decisively to real imbalances.

### How It Works

```
if |netFlow| <= noiseThreshold:
    signal = none  (filtered out)
else:
    excess = |netFlow| - noiseThreshold
    magnitude = excess * proportionalGain / FLOW_SCALE
```

- `noiseThreshold` (0+): Flows below this are considered noise. No signal emitted.
- `proportionalGain` (0+): Multiplier on the excess above threshold. Controls aggressiveness.
- The dead zone creates a clean separation between "noise" and "signal".

### When It Excels

- **Whale + noise mix**: Whale transfers punch through the threshold; small noise doesn't. Clean signal extraction.
- **Sustained drain**: Once drain rate clears the threshold, proportional response kicks in reliably.
- **Burst spikes**: Large bursts exceed threshold immediately, triggering fast response.

### When It Struggles

- **Gradual ramps starting below threshold**: If the ramp is slow enough that net flow stays below threshold for many cycles, the strategy is blind until the ramp crosses the threshold.
- **Threshold tuning**: Setting the threshold too high misses real signals; too low defeats the noise filtering purpose.

### Key Parameters

| Parameter             | Description                          | Typical Value |
| --------------------- | ------------------------------------ | ------------- |
| `noiseThreshold`      | Minimum net flow to trigger a signal | 0.05          |
| `proportionalGain`    | Response multiplier above threshold  | 1.0           |
| `windowSizeMs`        | Lookback window                      | 5000          |
| `minSamplesForSignal` | Minimum samples required             | 3             |
| `coldStartCycles`     | Cold start skip cycles               | 2             |

---

## Strategy 4: Acceleration Flow (Second Derivative)

### Intent

Detect **changes in trend** -- not just "is flow happening?" but "is flow _accelerating_?". If a drain is getting worse over time (negative acceleration), react more aggressively. If it's stabilizing, ease off. This is the most anticipatory strategy, aiming to get ahead of emerging problems.

### How It Works

```
acceleration = currentNetFlow - previousNetFlow
dampedComponent = |currentNetFlow| * damping / FLOW_SCALE
accelerationComponent = |acceleration| * accelerationWeight / FLOW_SCALE
magnitude = dampedComponent + accelerationComponent
```

- `accelerationWeight` (0-1): How much weight to give the second derivative.
- `damping` (0-1): How much weight to give the current flow level (first derivative). Acts as a floor.
- Direction follows the current net flow; if flow is zero, direction follows acceleration.

### When It Excels

- **Trend changes**: Detecting when a previously stable situation starts deteriorating. The acceleration component fires before the absolute flow gets large.
- **Decelerating drain**: As drain slows, acceleration component drops, naturally reducing rebalance volume.

### When It Struggles

- **Over-reactivity**: With aggressive parameters, acceleration responds to every tick of flow change, generating many small rebalances that overwhelm bridge capacity. This is the most common failure mode observed in simulations.
- **Oscillating traffic**: Direction changes cause large acceleration values in both directions.
- **Noisy data**: Small random variations in flow produce acceleration noise.

### Key Parameters

| Parameter             | Description                                              | Typical Value |
| --------------------- | -------------------------------------------------------- | ------------- |
| `accelerationWeight`  | Weight of the acceleration (second derivative) component | 0.5           |
| `damping`             | Weight of the current flow (first derivative) component  | 0.1           |
| `windowSizeMs`        | Lookback window                                          | 5000          |
| `minSamplesForSignal` | Minimum samples required                                 | 3             |
| `coldStartCycles`     | Cold start skip cycles                                   | 2             |

---

## Shared Architecture

All strategies inherit from `FlowReactiveBaseStrategy`, which handles:

1. **Flow collection**: Queries `IActionTracker.getRecentTransfers()` to build per-chain flow history
2. **Domain mapping**: Translates on-chain domain IDs to chain names via `domainToChainName`
3. **Cold start protection**: Skips first N polling cycles while flow window fills
4. **Signal-to-route conversion**: Converts `FlowSignal[]` into rebalance routes that `BaseStrategy.filterRoutes()` validates against on-chain balances

### Arithmetic

All strategies use **scaled BigInt arithmetic** with `FLOW_SCALE = 1000n` to avoid floating-point. User-facing config floats (like `alpha: 0.3`) are converted to scaled integers at construction time (`alphaScale = 300n`).

### Registration

All strategies are registered in `StrategyFactory` and can be selected via YAML config:

```yaml
strategy:
  rebalanceStrategy: emaFlow # or velocityFlow, thresholdFlow, accelerationFlow
  chains:
    ethereum:
      emaFlow:
        alpha: 0.3
        windowSizeMs: 5000
        minSamplesForSignal: 3
        coldStartCycles: 2
      bridge: '0x...'
```
