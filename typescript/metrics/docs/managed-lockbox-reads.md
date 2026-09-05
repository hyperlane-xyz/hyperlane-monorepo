# Managed-lockbox collateral observation

## Problem

Both warp-monitor and rebalancer first read a managed lockbox's collateral balance, then fetch its collateral metadata. The balance helper already returns tokenAddress, but metadata resolution repeated the ERC20() address read.

A bounded production Prometheus query on 2026-09-05 found two hyperlane_warp_route_token_balance series with token_standard="EvmManagedLockbox": one centralized monitor and one oUSDT rebalancer. One-hour log samples contained six monitor and 26 rebalancer successful collateral-balance messages. This establishes a modest active consumer; it is not a deployed performance measurement or a fleet-wide throughput estimate.

## Solution

getManagedLockBoxCollateralInfo accepts an optional collateral address from the current balance observation. Both current callers pass balance.tokenAddress. Standalone callers still read ERC20() afresh. There is no persistent cache.

If the lockbox's ERC20 address changes between the balance and metadata steps, metadata now refers to the token whose balance was actually measured. The next balance sample reads the current address. This is not a block-atomic observation: balance and metadata still use their normal latest-state reads.

All three metadata reads remain: decimals, symbol and name. Their existing failures still reject the sample; removing unused values must not accidentally hide metadata failures.

## Numerical evidence

The real ethers/SDK adapter fixture stubs provider contract calls:

- Before: ERC20 + balanceOf + ERC20 + decimals + symbol + name = 6 calls.
- After: ERC20 + balanceOf + decimals + symbol + name = 5 calls (16.7% fewer).
- Standalone metadata: 4 calls, unchanged.
- Next successful balance/metadata observation: another 5 fresh calls.

Balances, USD values, names and addresses match for unchanged collateral. The fixture covers an intervening collateral-address change, standalone freshness and each metadata failure followed by a fresh retry. Counts exclude price-getter requests and provider transport overhead. No production latency reduction is claimed.

## Validation

29 metrics, 42 warp-monitor and 380 rebalancer tests passed. The dependency/service build passed 20 tasks and all three package lints passed (existing rebalancer expect-expression warnings). Runtime tests use the previously documented ignored core-js compatibility shim required by the locked Provable dependency; no dependency/lockfile changes are included. Self-review and independent review found no blockers.

Reproduce the provider call counts with:

```sh
pnpm -C typescript/metrics test
```

See src/managed-lockbox.test.ts. No deployment was performed.
