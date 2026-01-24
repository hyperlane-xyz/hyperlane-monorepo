/**
 * StrategyAdapter
 *
 * Adapts real rebalancer strategies to the simulation interface.
 */
import type { Logger } from 'pino';

import type { ChainMap, Token } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type {
  ISimulationStrategy,
  InflightContext,
  RebalancingRoute,
} from './types.js';

/**
 * A simple no-op strategy that never rebalances.
 * Useful as a baseline for comparison.
 */
export class NoOpStrategy implements ISimulationStrategy {
  getRebalancingRoutes(
    _balances: Record<string, bigint>,
    _inflight: InflightContext,
  ): RebalancingRoute[] {
    return [];
  }
}

/**
 * A simple threshold-based strategy for testing.
 * Rebalances when any chain falls below a minimum threshold.
 */
export class SimpleThresholdStrategy implements ISimulationStrategy {
  constructor(
    private readonly chains: string[],
    private readonly minBalance: bigint,
    private readonly targetBalance: bigint,
    private readonly bridges: Record<string, Address>, // "origin-dest" -> bridge
  ) {}

  getRebalancingRoutes(
    balances: Record<string, bigint>,
    inflight: InflightContext,
  ): RebalancingRoute[] {
    const routes: RebalancingRoute[] = [];

    // Account for pending rebalances
    const effectiveBalances = { ...balances };
    for (const pr of inflight.pendingRebalances) {
      // Add to destination (will arrive)
      effectiveBalances[pr.destination] =
        (effectiveBalances[pr.destination] ?? 0n) + pr.amount;
    }

    // Account for pending transfers (will consume collateral)
    for (const pt of inflight.pendingTransfers) {
      effectiveBalances[pt.destination] =
        (effectiveBalances[pt.destination] ?? 0n) - pt.amount;
    }

    // Find chains below minimum
    const deficits: Array<{ chain: string; amount: bigint }> = [];
    const surpluses: Array<{ chain: string; amount: bigint }> = [];

    for (const chain of this.chains) {
      const balance = effectiveBalances[chain] ?? 0n;

      if (balance < this.minBalance) {
        // Needs rebalancing
        const deficit = this.targetBalance - balance;
        deficits.push({ chain, amount: deficit > 0n ? deficit : 0n });
      } else if (balance > this.targetBalance) {
        // Has surplus
        const surplus = balance - this.targetBalance;
        surpluses.push({ chain, amount: surplus });
      }
    }

    // Sort by amount (largest first)
    deficits.sort((a, b) => (b.amount > a.amount ? 1 : -1));
    surpluses.sort((a, b) => (b.amount > a.amount ? 1 : -1));

    // Match surpluses to deficits
    for (const deficit of deficits) {
      for (const surplus of surpluses) {
        if (surplus.amount <= 0n) continue;
        if (deficit.amount <= 0n) break;

        const bridgeKey = `${surplus.chain}-${deficit.chain}`;
        const bridge = this.bridges[bridgeKey];
        if (!bridge) continue;

        const transferAmount =
          surplus.amount < deficit.amount ? surplus.amount : deficit.amount;

        routes.push({
          origin: surplus.chain,
          destination: deficit.chain,
          amount: transferAmount,
          bridge,
        });

        surplus.amount -= transferAmount;
        deficit.amount -= transferAmount;
      }
    }

    return routes;
  }
}

/**
 * Adapter to wrap actual rebalancer strategies for simulation.
 * This allows testing real WeightedStrategy, MinAmountStrategy, etc.
 */
export class RealStrategyAdapter implements ISimulationStrategy {
  constructor(
    private readonly strategy: {
      getRebalancingRoutes(
        balances: Record<string, bigint>,
        inflight: {
          pendingRebalances: RebalancingRoute[];
          pendingTransfers: RebalancingRoute[];
        },
      ): RebalancingRoute[];
    },
  ) {}

  getRebalancingRoutes(
    balances: Record<string, bigint>,
    inflight: InflightContext,
  ): RebalancingRoute[] {
    return this.strategy.getRebalancingRoutes(balances, inflight);
  }
}

/**
 * Factory to create strategy adapters for simulation.
 */
export function createSimulationStrategy(
  type: 'noop' | 'threshold',
  options?: {
    chains?: string[];
    minBalance?: bigint;
    targetBalance?: bigint;
    bridges?: Record<string, Address>;
  },
): ISimulationStrategy {
  switch (type) {
    case 'noop':
      return new NoOpStrategy();

    case 'threshold':
      if (
        !options?.chains ||
        !options?.minBalance ||
        !options?.targetBalance ||
        !options?.bridges
      ) {
        throw new Error(
          'Threshold strategy requires chains, minBalance, targetBalance, and bridges',
        );
      }
      return new SimpleThresholdStrategy(
        options.chains,
        options.minBalance,
        options.targetBalance,
        options.bridges,
      );

    default:
      throw new Error(`Unknown strategy type: ${type}`);
  }
}
