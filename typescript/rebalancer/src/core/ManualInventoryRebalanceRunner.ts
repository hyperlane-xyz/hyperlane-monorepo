import type { Logger } from 'pino';

import type { ChainMap, WarpCore } from '@hyperlane-xyz/sdk';
import { assert, sleep } from '@hyperlane-xyz/utils';

import type { ExternalBridgeRegistry } from '../interfaces/IExternalBridge.js';
import type { IInventoryRebalancer } from '../interfaces/IRebalancer.js';
import type { InventoryRoute } from '../interfaces/IStrategy.js';
import {
  fetchInventoryBalances,
  type InventoryMonitorConfig,
} from '../monitor/Monitor.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';

const POLL_INTERVAL_MS = 15_000;

export interface ManualInventoryRunnerClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface ManualInventoryRebalancer extends IInventoryRebalancer {
  setInventoryBalances(balances: ChainMap<bigint>): void;
}

export type ManualInventoryActionTracker = Pick<
  IActionTracker,
  | 'cancelRebalanceIntent'
  | 'getActionsForIntent'
  | 'getActiveRebalanceIntents'
  | 'getPartiallyFulfilledInventoryIntents'
  | 'getRebalanceIntent'
  | 'logStoreContents'
  | 'syncInventoryMovementActions'
  | 'syncRebalanceActions'
  | 'syncRebalanceIntents'
>;

export interface ManualInventoryRebalanceRunnerDeps {
  actionTracker: ManualInventoryActionTracker;
  externalBridgeRegistry: Partial<ExternalBridgeRegistry>;
  inventoryConfig: InventoryMonitorConfig;
  inventoryRebalancer: ManualInventoryRebalancer;
  logger: Logger;
  warpCore: WarpCore;
  clock?: ManualInventoryRunnerClock;
}

/**
 * Attended manual workflow. Dispatched Hyperlane deposits are discoverable in
 * Explorer. External bridge transfers submitted before their action is recorded
 * have no durable local state and require operator checks on restart.
 */
export class ManualInventoryRebalanceRunner {
  private readonly clock: ManualInventoryRunnerClock;

  constructor(private readonly deps: ManualInventoryRebalanceRunnerDeps) {
    this.clock = deps.clock ?? { now: Date.now, sleep };
  }

  async run(route: InventoryRoute, timeoutMs: number): Promise<void> {
    assert(
      Number.isFinite(timeoutMs) && timeoutMs > 0,
      'Manual inventory timeout must be greater than 0',
    );
    await this.assertNoActiveInventoryIntent();

    const deadline = this.clock.now() + timeoutMs;
    let cycle = 0;
    let firstCycle = true;
    let intentId: string | undefined;

    while (true) {
      cycle += 1;
      const inventoryBalances = await fetchInventoryBalances(
        this.deps.warpCore,
        this.deps.inventoryConfig,
        this.deps.logger,
      );
      this.deps.inventoryRebalancer.setInventoryBalances(inventoryBalances);

      await this.deps.actionTracker.syncInventoryMovementActions(
        this.deps.externalBridgeRegistry,
      );
      await this.deps.actionTracker.syncRebalanceActions();
      await this.deps.actionTracker.syncRebalanceIntents();

      const intent = intentId
        ? await this.deps.actionTracker.getRebalanceIntent(intentId)
        : undefined;
      this.deps.logger.info(
        {
          cycle,
          intentId,
          intentStatus: intent?.status ?? 'not_created',
          origin: route.origin,
          originInventory: (inventoryBalances[route.origin] ?? 0n).toString(),
          destination: route.destination,
          destinationInventory: (
            inventoryBalances[route.destination] ?? 0n
          ).toString(),
        },
        'Manual inventory rebalance polling cycle',
      );

      if (intentId && (await this.isTerminal(intentId))) return;
      if (this.clock.now() >= deadline) {
        await this.throwTimeout();
      }

      const results = await this.deps.inventoryRebalancer.rebalance(
        firstCycle ? [route] : [],
      );
      const result = results[0];
      if (firstCycle) {
        assert(
          result?.intentId,
          'Manual inventory rebalance did not create an intent',
        );
        intentId = result.intentId;
        firstCycle = false;
        if (!result.success) {
          await this.deps.actionTracker.cancelRebalanceIntent(intentId);
          throw new Error(
            `Manual inventory rebalance dispatch failed: ${result.error ?? 'unknown error'}. Verify external bridge status and destination inventory before retrying.`,
          );
        }
      } else if (result) {
        assert(
          result.intentId === intentId,
          `Manual inventory rebalance returned unexpected intent ${result.intentId}`,
        );
        if (!result.success) {
          this.deps.logger.warn(
            { cycle, intentId, error: result.error },
            'Manual inventory rebalance cycle failed; continuing to poll',
          );
        }
      }

      assert(intentId, 'Manual inventory rebalance intent is missing');
      if (await this.isTerminal(intentId)) return;

      const remainingMs = deadline - this.clock.now();
      if (remainingMs <= 0) await this.throwTimeout();
      await this.clock.sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
    }
  }

  private async assertNoActiveInventoryIntent(): Promise<void> {
    const [partialIntents, inProgressIntents] = await Promise.all([
      this.deps.actionTracker.getPartiallyFulfilledInventoryIntents(),
      this.deps.actionTracker.getActiveRebalanceIntents(),
    ]);
    const blockingIntentId =
      partialIntents[0]?.intent.id ??
      inProgressIntents.find((intent) => intent.executionMethod === 'inventory')
        ?.id;
    assert(
      !blockingIntentId,
      `Cannot start manual inventory rebalance while intent ${blockingIntentId} is active`,
    );
  }

  private async isTerminal(intentId: string): Promise<boolean> {
    const intent = await this.deps.actionTracker.getRebalanceIntent(intentId);
    if (!intent) return false;
    if (intent.status === 'failed' || intent.status === 'cancelled') {
      throw new Error(
        `Manual inventory rebalance intent ${intentId} reached terminal status ${intent.status}`,
      );
    }
    if (intent.status !== 'complete') return false;

    const actions = await this.deps.actionTracker.getActionsForIntent(intentId);
    const completedAmount = actions
      .filter(
        (action) =>
          action.type === 'inventory_deposit' && action.status === 'complete',
      )
      .reduce((sum, action) => sum + action.amount, 0n);
    if (completedAmount === 0n) {
      throw new Error(
        `Manual inventory rebalance intent ${intentId} completed without moving funds — amount below the gas-based minimum viable transfer`,
      );
    }
    if (completedAmount < intent.amount) {
      this.deps.logger.warn(
        {
          intentId,
          completedAmount: completedAmount.toString(),
          requestedAmount: intent.amount.toString(),
          writtenOffAmount: (intent.amount - completedAmount).toString(),
        },
        'Manual inventory rebalance completed with a written-off remainder',
      );
    }
    this.deps.logger.info(
      {
        intentId,
        completedAmount: completedAmount.toString(),
        requestedAmount: intent.amount.toString(),
      },
      'Manual inventory rebalance completed successfully',
    );
    return true;
  }

  private async throwTimeout(): Promise<never> {
    await this.deps.actionTracker.logStoreContents();
    throw new Error(
      'Manual inventory rebalance timed out. Check external bridge status and destination inventory before rerunning: transfers submitted before tracking cannot be recovered automatically. Dispatched Hyperlane deposits remain relayable and can be recovered from Explorer once indexed.',
    );
  }
}
