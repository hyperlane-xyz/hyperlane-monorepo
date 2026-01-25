# Rebalancer Simulation Framework - Improvement Roadmap

## Current State Summary

### What We Have (Working)

| Test File | Test Cases | Status |
|-----------|-----------|--------|
| `integrated-simulation.e2e-test.ts` | 9 tests | ✅ Core tests passing |
| `inflight-tracking.e2e-test.ts` | 4 tests | ✅ Demonstrates inflight tracking |
| `scenario-tests.e2e-test.ts` | Route delivery timing tests | ✅ Passing |

### Key Scenarios Covered

1. **Basic Rebalancing** - 2 domains, imbalanced traffic, rebalancer corrects
2. **Comparison (With/Without)** - Proves rebalancer improves success rate (76.7% → 100%)
3. **Stress Test (50 transfers)** - Phase changes, sustained traffic
4. **Multi-Chain (3 domains)** - Parallel rebalancing across routes
5. **Inflight Tracking** - MockExplorer integration, collateral reservation
6. **Variable Route Timing** - Asymmetric/high-variance delivery delays

### Infrastructure Built

- `IntegratedSimulation` - Full E2E with real RebalancerService
- `MockExplorerServer` - Inflight message tracking
- `SimulatedTokenBridge` - Configurable bridge simulation
- `OptimizedTrafficGenerator` - Efficient transfer execution
- Multi-signer architecture (avoids nonce conflicts)
- Per-domain rebalancer signers (parallel execution)

---

## Recommended Improvements

### Phase 1: Scenario Coverage (High Priority)

These scenarios test real-world failure modes that rebalancers must handle.

#### 1.1 Bridge Failure Scenarios
**Goal:** Test rebalancer resilience when bridges fail or become unavailable.

```typescript
// Test cases to add:
describe('Bridge Failure Scenarios', () => {
  it('should handle bridge timeout gracefully');
  it('should retry failed bridge transfers');
  it('should fallback to alternative bridge if primary fails');
  it('should not get stuck when bridge is permanently down');
});
```

**Implementation:**
- Add `failureRate` and `timeoutRate` to `SimulatedTokenBridge`
- Add `failNextTransfer()` method for deterministic testing
- Verify rebalancer logs errors and continues operating

#### 1.2 Rapid Imbalance Scenarios
**Goal:** Test rebalancer response to sudden, large imbalances.

```typescript
describe('Rapid Imbalance Scenarios', () => {
  it('should handle whale transfer that drains 80% of collateral');
  it('should handle simultaneous large transfers to same destination');
  it('should recover from flash imbalance within X polling cycles');
});
```

#### 1.3 Edge Case Balances
**Goal:** Test behavior at boundary conditions.

```typescript
describe('Edge Case Balances', () => {
  it('should handle domain with zero collateral');
  it('should handle domain at exact minimum threshold');
  it('should handle all domains below target simultaneously');
  it('should handle rounding errors in large transfers');
});
```

#### 1.4 Multi-Rebalancer Coordination
**Goal:** Test multiple rebalancers operating on same warp route.

```typescript
describe('Multi-Rebalancer Scenarios', () => {
  it('should not double-rebalance when two services see same imbalance');
  it('should handle race conditions in bridge execution');
});
```

**Implementation:**
- Run two `RebalancerService` instances simultaneously
- Verify they don't conflict or duplicate work

---

### Phase 2: Strategy Coverage (Medium Priority)

Currently only `WeightedStrategy` is tested. Add coverage for other strategies.

#### 2.1 MinAmount Strategy Tests

```typescript
describe('MinAmount Strategy', () => {
  it('should maintain minimum amount on each domain');
  it('should only rebalance when below minimum');
  it('should not over-rebalance above minimum');
});
```

#### 2.2 Strategy Comparison Tests

```typescript
describe('Strategy Comparison', () => {
  it('should compare weighted vs minAmount on same traffic');
  it('should measure fee efficiency of each strategy');
  it('should measure latency impact of each strategy');
});
```

---

### Phase 3: Metrics & Observability (Medium Priority)

#### 3.1 Enhanced Metrics Collection

Add metrics that matter for production:
- **Rebalancer reaction time** - Time from imbalance detection to bridge execution
- **Bridge utilization** - How efficiently bridge capacity is used
- **Collateral efficiency** - Ratio of successful transfers to total collateral
- **Fee efficiency** - Fees paid vs transfer volume supported

```typescript
interface EnhancedMetrics {
  reactionTimeMs: { p50: number; p95: number; p99: number };
  bridgeUtilization: number; // 0-1
  collateralEfficiency: number; // transfers supported / total collateral
  feesPerTransfer: bigint;
  imbalanceEvents: number;
  rebalanceOperations: number;
}
```

#### 3.2 Visualization Improvements

- Add timeline chart showing balance changes over time
- Add heatmap of transfer patterns
- Export results to JSON for external analysis

---

### Phase 4: Realistic Traffic Patterns (Lower Priority)

#### 4.1 Historical Traffic Replay

```typescript
// Load real traffic data from production logs
const traffic = await loadHistoricalTraffic('warp-route-xyz', {
  startDate: '2025-01-01',
  endDate: '2025-01-07',
});

const results = await simulation.run({
  name: 'historical-replay',
  durationMs: 60_000,
  transfers: traffic.scaled(0.01), // 1% speed
});
```

#### 4.2 Adversarial Traffic Patterns

```typescript
describe('Adversarial Traffic', () => {
  it('should handle traffic designed to drain specific domain');
  it('should handle oscillating traffic that triggers constant rebalancing');
  it('should handle traffic that maximizes bridge fees');
});
```

---

### Phase 5: Performance & Scale (Lower Priority)

#### 5.1 Performance Benchmarks

```typescript
describe('Performance Benchmarks', () => {
  it('should handle 100 transfers in under 60 seconds');
  it('should handle 5 domains with 50 transfers each');
  it('should not degrade with 10+ pending transfers');
});
```

#### 5.2 Long-Running Stability

```typescript
describe('Long-Running Stability', () => {
  it('should run for 10 minutes without memory leaks');
  it('should handle 1000+ transfers over extended period');
});
```

---

## Implementation Priority

| Phase | Effort | Impact | Priority |
|-------|--------|--------|----------|
| 1.1 Bridge Failures | Medium | High | **P0** |
| 1.2 Rapid Imbalance | Low | High | **P0** |
| 1.3 Edge Cases | Low | Medium | **P1** |
| 1.4 Multi-Rebalancer | High | Medium | **P2** |
| 2.1 MinAmount Strategy | Medium | Medium | **P1** |
| 2.2 Strategy Comparison | Medium | Medium | **P2** |
| 3.1 Enhanced Metrics | Medium | Medium | **P1** |
| 3.2 Visualization | Low | Low | **P3** |
| 4.1 Historical Replay | High | Medium | **P3** |
| 4.2 Adversarial Traffic | Medium | Medium | **P2** |
| 5.1 Performance | Low | Low | **P3** |
| 5.2 Long-Running | Medium | Low | **P3** |

---

## Quick Wins (Can Do Now)

These require minimal code changes:

### 1. Add more traffic patterns to existing tests

```typescript
// In TrafficPatterns.ts, add:
export const trafficPatterns = {
  // ... existing patterns
  
  whale: (config) => {
    // Single large transfer that drains 80% of destination
    return [{
      time: 0,
      origin: config.chains[0],
      destination: config.chains[1],
      amount: config.baseAmount * 40n, // 80% of 50-token balance
    }];
  },
  
  oscillating: (config) => {
    // Alternating direction every N transfers
    // Designed to stress rebalancer
  },
  
  concentrated: (config) => {
    // All transfers to single destination
    // Tests worst-case drain scenario
  },
};
```

### 2. Add bridge failure flag to SimulatedTokenBridge

```solidity
// In SimulatedTokenBridge.sol
bool public failNextTransfer;

function setFailNextTransfer(bool _fail) external {
    failNextTransfer = _fail;
}

function transferRemote(...) external returns (bytes32) {
    if (failNextTransfer) {
        failNextTransfer = false;
        revert("Bridge temporarily unavailable");
    }
    // ... existing logic
}
```

### 3. Enable MockExplorer by default in comparison tests

Currently the comparison test doesn't use MockExplorer. Enabling it would:
- Make the rebalancer smarter about pending transfers
- Potentially improve results further
- Test the full production behavior

---

## File Structure After Improvements

```
typescript/cli/src/tests/rebalancer/simulation/
├── README.md                    # How to run tests
├── ROADMAP.md                   # This file
├── PLAN-v2.md                   # Implementation details
└── v2/
    ├── IntegratedSimulation.ts
    ├── MockRegistry.ts
    ├── OptimizedTrafficGenerator.ts
    ├── TrafficPatterns.ts        # Add more patterns
    ├── SimulationVisualizer.ts
    ├── types.ts
    │
    ├── tests/
    │   ├── basic.e2e-test.ts           # Smoke, basic rebalancing
    │   ├── comparison.e2e-test.ts      # With/without rebalancer
    │   ├── stress.e2e-test.ts          # High volume, phase changes
    │   ├── multichain.e2e-test.ts      # 3+ domains
    │   ├── inflight.e2e-test.ts        # MockExplorer, pending transfers
    │   ├── failures.e2e-test.ts        # Bridge failures, edge cases
    │   ├── strategies.e2e-test.ts      # MinAmount, strategy comparison
    │   └── performance.e2e-test.ts     # Benchmarks, long-running
    │
    └── scenarios/
        ├── whale-transfer.yaml         # Scenario definitions
        ├── oscillating-traffic.yaml
        └── historical-replay.yaml
```

---

## Success Criteria

The simulation framework is "complete" when:

1. **Coverage**: All rebalancer strategies tested (Weighted, MinAmount)
2. **Failure Modes**: Bridge failures, timeouts, edge cases covered
3. **Confidence**: Can run simulation before deploying new rebalancer version
4. **Performance**: Can simulate 100+ transfers in reasonable time (<2 min)
5. **Documentation**: New developers can add scenarios without understanding internals

---

## Next Steps

1. **Immediate**: Add bridge failure scenarios (Phase 1.1)
2. **This Week**: Add rapid imbalance and edge case tests (Phase 1.2, 1.3)
3. **Next Sprint**: Add MinAmount strategy tests (Phase 2.1)
4. **Ongoing**: Add scenarios as production issues are discovered
