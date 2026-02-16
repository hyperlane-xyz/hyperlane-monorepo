import { EventEmitter } from 'events';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import type { StrategyConfig } from '../../config/types.js';
import { RebalancerStrategyOptions } from '../../config/types.js';
import type { InventoryBalances } from '../../interfaces/IInventoryMonitor.js';
import type {
  RebalanceAction,
  RebalanceIntent,
  Transfer,
} from '../../tracking/types.js';
import type {
  DashboardState,
  UIAction,
  UIBalanceData,
  UIIntent,
  UITransfer,
} from '../types.js';

export class UIStateManager extends EventEmitter {
  private state: DashboardState = {
    balances: [],
    transfers: [],
    intents: [],
    actions: [],
  };

  constructor(private domainToChainName: Map<number, string>) {
    super();
  }

  updateFullState(params: {
    rawBalances: ChainMap<bigint>;
    inventoryBalances: InventoryBalances;
    strategyConfig: StrategyConfig[];
    transfers: Transfer[];
    intents: RebalanceIntent[];
    actions: RebalanceAction[];
  }): void {
    this.state.balances = this.computeBalances(
      params.rawBalances,
      params.inventoryBalances,
      params.strategyConfig,
    );

    this.state.transfers = params.transfers.map((t) => this.enrichTransfer(t));
    this.state.intents = params.intents.map((i) => this.enrichIntent(i));
    this.state.actions = params.actions.map((a) => this.enrichAction(a));

    this.emit('state', this.state);
  }

  getState(): DashboardState {
    return this.state;
  }

  private computeBalances(
    rawBalances: ChainMap<bigint>,
    inventoryBalances: InventoryBalances,
    strategyConfig: StrategyConfig[],
  ): UIBalanceData[] {
    const chains = Object.keys(rawBalances);
    const balances: UIBalanceData[] = [];

    let totalBalance = 0n;
    const chainBalances = new Map<string, bigint>();

    for (const chain of chains) {
      const routerCollateral = rawBalances[chain] || 0n;
      const inventory = inventoryBalances.get(chain)?.balance || 0n;
      const chainBalance = routerCollateral + inventory;
      chainBalances.set(chain, chainBalance);
      totalBalance += chainBalance;
    }

    const weightedStrategy = strategyConfig.find(
      (s) => s.rebalanceStrategy === RebalancerStrategyOptions.Weighted,
    );

    let totalWeight = 0n;
    const chainWeights = new Map<string, bigint>();

    if (weightedStrategy) {
      for (const chain of chains) {
        const chainConfig = weightedStrategy.chains[chain];
        if (chainConfig && 'weighted' in chainConfig) {
          const weight = chainConfig.weighted.weight;
          chainWeights.set(chain, weight);
          totalWeight += weight;
        }
      }
    }

    for (const chain of chains) {
      const routerCollateral = rawBalances[chain] || 0n;
      const inventory = inventoryBalances.get(chain)?.balance || 0n;
      const chainBalance = chainBalances.get(chain)!;

      let currentWeight = 0;
      if (totalBalance > 0n) {
        currentWeight = Number((chainBalance * 10000n) / totalBalance) / 100;
      }

      let targetWeight: number | null = null;
      let deviation: number | null = null;

      if (weightedStrategy && totalWeight > 0n) {
        const weight = chainWeights.get(chain) || 0n;
        targetWeight = Number((weight * 10000n) / totalWeight) / 100;
        deviation = currentWeight - targetWeight;
      }

      balances.push({
        chain,
        routerCollateral: routerCollateral.toString(),
        inventory: inventory.toString(),
        targetWeight,
        currentWeight,
        deviation,
      });
    }

    return balances.sort((a, b) => a.chain.localeCompare(b.chain));
  }

  private enrichTransfer(transfer: Transfer): UITransfer {
    return {
      id: transfer.id,
      status: transfer.status,
      origin: transfer.origin,
      destination: transfer.destination,
      originChainName: this.resolveChainName(transfer.origin),
      destinationChainName: this.resolveChainName(transfer.destination),
      amount: transfer.amount.toString(),
      messageId: transfer.messageId,
      sender: transfer.sender,
      recipient: transfer.recipient,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
    };
  }

  private enrichIntent(intent: RebalanceIntent): UIIntent {
    return {
      id: intent.id,
      status: intent.status,
      origin: intent.origin,
      destination: intent.destination,
      originChainName: this.resolveChainName(intent.origin),
      destinationChainName: this.resolveChainName(intent.destination),
      amount: intent.amount.toString(),
      executionMethod: intent.executionMethod,
      bridge: intent.bridge,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    };
  }

  private enrichAction(action: RebalanceAction): UIAction {
    return {
      id: action.id,
      status: action.status,
      type: action.type,
      origin: action.origin,
      destination: action.destination,
      originChainName: this.resolveChainName(action.origin),
      destinationChainName: this.resolveChainName(action.destination),
      amount: action.amount.toString(),
      intentId: action.intentId,
      txHash: action.txHash || null,
      bridgeTransferId: action.bridgeTransferId || null,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
    };
  }

  private resolveChainName(domainId: number): string {
    return this.domainToChainName.get(domainId) || `unknown-${domainId}`;
  }
}
