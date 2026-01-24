# Rebalancer Unit Test Harness - Implementation Plan

## Overview

A test harness for testing rebalancer **strategy logic** on a single anvil instance with multiple simulated domains. Focuses on fast iteration and testing individual strategy behaviors.

## Status: Phase 1 Complete

**Branch:** `nambrot/rebalancer-test-harness`  
**PR:** https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/7880

## What Was Built

### Core Harness (`harness/`)

| File               | Description                                                                             | Status        |
| ------------------ | --------------------------------------------------------------------------------------- | ------------- |
| `setup.ts`         | `createRebalancerTestSetup()` - deploys mailboxes, warp routes, bridges on single anvil | Done          |
| `transfer.ts`      | `transferAndRelay()`, `getAllWarpRouteBalances()`                                       | Done          |
| `config.ts`        | `writeWeightedConfig()`, `writeMinAmountConfig()`                                       | Done          |
| `phases.ts`        | `createPhaseRunner()`, `Phase` enum for lifecycle testing                               | Done          |
| `mock-explorer.ts` | `MockExplorerServer` for inflight message testing                                       | Done (unused) |
| `index.ts`         | Re-exports all utilities                                                                | Done          |

### Test Coverage (`rebalancer.e2e-test.ts`)

| Test Suite                 | Tests                                                     | Status |
| -------------------------- | --------------------------------------------------------- | ------ |
| Weighted Strategy          | 4 tests (imbalance, balanced, tolerance, unequal weights) | Done   |
| MinAmount Strategy         | 4 tests (deficit, all above min, config file, relative)   | Done   |
| CollateralDeficit Strategy | 3 tests (pending transfer, no deficit, pending rebalance) | Done   |
| Balance Tracking           | 1 test                                                    | Done   |
| Test Isolation             | 2 tests (snapshot/restore)                                | Done   |
| Phase-Based Testing        | 2 tests (state capture, crash simulation)                 | Done   |

**Total: 16 passing tests**

## Remaining Work (Deferred)

### Not Started

| Task                                             | Priority | Notes                                        |
| ------------------------------------------------ | -------- | -------------------------------------------- |
| Inflight Awareness tests with MockExplorerServer | Medium   | Requires wiring up full ActionTracker        |
| Bridge Failure tests                             | Medium   | Requires simulating bridge contract failures |
| Multi-chain tests (3+ collateral domains)        | Low      | Current tests use 2 collateral + 1 synthetic |
| Configuration Validation tests                   | Low      | Test invalid configs are rejected            |

## Key Design Decisions

1. **Single anvil with multiple domain IDs** - Deploy multiple Mailbox contracts with different domain IDs (1, 2, 3) on single anvil. Tests run in ~2 seconds.

2. **TestISM for easy message relay** - No validator setup needed; manually call `process()` on destination mailbox.

3. **Direct strategy testing** - Tests use strategies directly (`WeightedStrategy`, `MinAmountStrategy`, `CollateralDeficitStrategy`) rather than full `RebalancerContextFactory` to avoid registry dependencies.

4. **Snapshot/restore for isolation** - Each test restores to base snapshot via `evm_snapshot`/`evm_revert`.

## Important Learning

When transferring from collateral chain to synthetic chain via `transferRemote`, collateral **INCREASES** (tokens are locked into the warp route), not decreases. This is counterintuitive but correct - the user deposits tokens which get locked as collateral.

## How to Run

```bash
# Start anvil
anvil --port 8545

# Run tests
cd typescript/cli
pnpm mocha --node-option import=tsx/esm "src/tests/rebalancer/rebalancer.e2e-test.ts"
```

## Limitations

This harness tests **strategy logic in isolation**. It does NOT:

- Test end-to-end rebalancer behavior under realistic traffic
- Measure latency or cost efficiency
- Replay historical traffic
- Compare strategies against each other

For those use cases, see [PLAN-simulation-harness.md](./PLAN-simulation-harness.md).
