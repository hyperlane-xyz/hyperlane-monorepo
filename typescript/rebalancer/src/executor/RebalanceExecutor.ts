import type { Logger } from 'pino';

import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';
import type { RebalanceTracker } from '../tracker/RebalanceTracker.js';
import type { Execution, ExecutionType, Rebalance } from '../tracker/types.js';

/**
 * Configuration for inventory on each chain
 */
export type InventoryConfig = {
  /** Address holding inventory (e.g., EOA or multisig) */
  inventoryAddress: string;
  /** Minimum inventory to keep on this chain */
  minInventory: bigint;
};

/**
 * Provider for checking inventory balances
 */
export interface IInventoryProvider {
  /** Get current inventory balance on a chain */
  getInventoryBalance(chain: ChainName): Promise<bigint>;
}

/**
 * Provider for moving inventory between chains (e.g., via LiFi)
 */
export interface IInventoryBridge {
  /** Move inventory from one chain to another */
  moveInventory(
    origin: ChainName,
    destination: ChainName,
    amount: bigint,
  ): Promise<{ txHash: string }>;

  /** Check if an inventory movement is complete */
  isMovementComplete(txHash: string): Promise<boolean>;
}

/**
 * RebalanceExecutor orchestrates the execution of rebalances.
 *
 * It handles:
 * - Converting strategy routes into tracked rebalances
 * - Multi-step execution (inventory movement → transferRemote)
 * - Non-blocking progression across rebalance cycles
 *
 * Architecture:
 * - Strategy decides direction & magnitude (simple)
 * - Executor decides HOW to execute (complex)
 */
export class RebalanceExecutor {
  private readonly logger: Logger;

  constructor(
    private readonly tracker: RebalanceTracker,
    private readonly rebalancer: IRebalancer,
    private readonly inventoryProvider?: IInventoryProvider,
    private readonly inventoryBridge?: IInventoryBridge,
    private readonly inventoryConfig?: ChainMap<InventoryConfig>,
    logger?: Logger,
  ) {
    this.logger = (logger ?? console) as Logger;
    if (logger) {
      this.logger = logger.child({ component: 'RebalanceExecutor' });
    }
  }

  /**
   * Process routes from strategy and create/progress rebalances.
   *
   * This is called each rebalance cycle. It:
   * 1. Creates new rebalances for routes that aren't already tracked
   * 2. Progresses existing rebalances through their execution steps
   */
  async processRoutes(routes: RebalancingRoute[]): Promise<void> {
    this.logger.info(
      { routeCount: routes.length },
      'Processing routes from strategy',
    );

    // 1. Create rebalances for new routes
    for (const route of routes) {
      await this.createRebalanceIfNeeded(route);
    }

    // 2. Progress existing rebalances
    await this.progressRebalances();

    // 3. Execute ready rebalance messages
    await this.executeReadyRebalances();

    // 4. Cleanup old completed rebalances
    this.tracker.cleanup();
  }

  /**
   * Create a rebalance for a route if one doesn't already exist.
   */
  private async createRebalanceIfNeeded(
    route: RebalancingRoute,
  ): Promise<Rebalance | null> {
    const rebalance = this.tracker.createRebalance({
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
    });

    if (!rebalance) {
      // Already exists
      return null;
    }

    // Plan the execution steps for this rebalance
    await this.planExecutions(rebalance);

    return rebalance;
  }

  /**
   * Plan the execution steps needed for a rebalance.
   *
   * For inventory rebalancing, this may include:
   * 1. inventory_movement - Move inventory to source chain via LiFi
   * 2. rebalance_message - Call transferRemote to move collateral
   */
  private async planExecutions(rebalance: Rebalance): Promise<void> {
    // Check if we have enough inventory on the origin chain
    const inventoryNeeded = await this.checkInventoryNeeded(rebalance);

    if (inventoryNeeded.length > 0) {
      // Create inventory movement executions
      for (const movement of inventoryNeeded) {
        this.tracker.createExecution({
          rebalanceId: rebalance.id,
          type: 'inventory_movement',
          origin: movement.fromChain,
          destination: rebalance.origin,
          amount: movement.amount,
        });
      }
    }

    // Create the final rebalance message execution
    this.tracker.createExecution({
      rebalanceId: rebalance.id,
      type: 'rebalance_message',
      origin: rebalance.origin,
      destination: rebalance.destination,
      amount: rebalance.amount,
    });
  }

  /**
   * Check if inventory movement is needed for a rebalance.
   * Returns the inventory movements needed, if any.
   */
  private async checkInventoryNeeded(
    rebalance: Rebalance,
  ): Promise<Array<{ fromChain: ChainName; amount: bigint }>> {
    if (!this.inventoryProvider || !this.inventoryConfig) {
      // No inventory management configured
      return [];
    }

    const originConfig = this.inventoryConfig[rebalance.origin];
    if (!originConfig) {
      return [];
    }

    const currentInventory = await this.inventoryProvider.getInventoryBalance(
      rebalance.origin,
    );

    // Calculate available inventory (clamped to 0 if below minimum)
    const rawAvailable = currentInventory - originConfig.minInventory;
    const availableInventory = rawAvailable > 0n ? rawAvailable : 0n;

    if (availableInventory >= rebalance.amount) {
      return [];
    }

    // Need to source inventory from other chains
    // Shortfall includes both the rebalance amount minus available,
    // plus any deficit below minimum (when rawAvailable was negative)
    const shortfall = rebalance.amount - rawAvailable;
    const movements: Array<{ fromChain: ChainName; amount: bigint }> = [];

    // Find chains with excess inventory
    for (const [chain, config] of Object.entries(this.inventoryConfig)) {
      if (chain === rebalance.origin) continue;

      const balance = await this.inventoryProvider.getInventoryBalance(chain);
      const excess = balance - config.minInventory;

      if (excess > 0n) {
        const toMove = excess > shortfall ? shortfall : excess;
        movements.push({ fromChain: chain, amount: toMove });

        // Check if we've covered the shortfall
        const totalMoving = movements.reduce((sum, m) => sum + m.amount, 0n);
        if (totalMoving >= shortfall) {
          break;
        }
      }
    }

    return movements;
  }

  /**
   * Progress pending rebalances through their execution steps.
   */
  private async progressRebalances(): Promise<void> {
    const pendingExecutions = this.tracker.getPendingExecutions();

    for (const execution of pendingExecutions) {
      await this.progressExecution(execution);
    }
  }

  /**
   * Progress a single execution.
   */
  private async progressExecution(execution: Execution): Promise<void> {
    switch (execution.type) {
      case 'inventory_movement':
        await this.progressInventoryMovement(execution);
        break;
      case 'rebalance_message':
        // Rebalance messages are handled separately in executeReadyRebalances
        break;
      case 'inventory_deposit':
        // Not implemented yet
        break;
    }
  }

  /**
   * Progress an inventory movement execution.
   */
  private async progressInventoryMovement(execution: Execution): Promise<void> {
    if (!this.inventoryBridge) {
      this.logger.warn(
        { executionId: execution.id },
        'Inventory bridge not configured, marking execution as failed',
      );
      this.tracker.updateExecutionStatus(execution.id, 'failed');
      return;
    }

    if (execution.status === 'not_started') {
      // Initiate the inventory movement
      try {
        const { txHash } = await this.inventoryBridge.moveInventory(
          execution.origin,
          execution.destination,
          execution.amount,
        );

        this.tracker.setExecutionTxHash(execution.id, txHash);
        this.tracker.updateExecutionStatus(execution.id, 'in_progress');

        this.logger.info(
          {
            executionId: execution.id,
            txHash,
            origin: execution.origin,
            destination: execution.destination,
            amount: execution.amount.toString(),
          },
          'Initiated inventory movement',
        );
      } catch (error) {
        this.logger.error(
          { executionId: execution.id, error },
          'Failed to initiate inventory movement',
        );
        this.tracker.updateExecutionStatus(execution.id, 'failed');
      }
    } else if (execution.status === 'in_progress' && execution.txHash) {
      // Check if the movement is complete
      try {
        const isComplete = await this.inventoryBridge.isMovementComplete(
          execution.txHash,
        );

        if (isComplete) {
          this.tracker.updateExecutionStatus(execution.id, 'complete');
          this.logger.info(
            { executionId: execution.id },
            'Inventory movement complete',
          );
        }
      } catch (error) {
        this.logger.error(
          { executionId: execution.id, error },
          'Failed to check inventory movement status',
        );
      }
    }
  }

  /**
   * Execute rebalance messages that are ready (all prerequisites complete).
   */
  private async executeReadyRebalances(): Promise<void> {
    const pendingRebalances = this.tracker.getPendingRebalances();
    const routesToExecute: RebalancingRoute[] = [];

    for (const rebalance of pendingRebalances) {
      if (this.isRebalanceReady(rebalance)) {
        routesToExecute.push({
          origin: rebalance.origin,
          destination: rebalance.destination,
          amount: rebalance.amount,
        });

        // Mark the rebalance_message execution as in_progress
        const executions = this.tracker.getExecutionsForRebalance(rebalance.id);
        const messageExecution = executions.find(
          (e) => e.type === 'rebalance_message',
        );
        if (messageExecution) {
          this.tracker.updateExecutionStatus(
            messageExecution.id,
            'in_progress',
          );
        }
      }
    }

    if (routesToExecute.length === 0) {
      return;
    }

    this.logger.info(
      { count: routesToExecute.length },
      'Executing ready rebalances',
    );

    try {
      await this.rebalancer.rebalance(routesToExecute);

      // Mark executions as complete
      for (const route of routesToExecute) {
        const rebalance = this.tracker.findPendingRebalance(
          route.origin,
          route.destination,
        );
        if (rebalance) {
          const executions = this.tracker.getExecutionsForRebalance(
            rebalance.id,
          );
          const messageExecution = executions.find(
            (e) => e.type === 'rebalance_message',
          );
          if (messageExecution) {
            this.tracker.updateExecutionStatus(messageExecution.id, 'complete');
          }
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to execute rebalances');

      // Mark executions as failed
      for (const route of routesToExecute) {
        const rebalance = this.tracker.findPendingRebalance(
          route.origin,
          route.destination,
        );
        if (rebalance) {
          const executions = this.tracker.getExecutionsForRebalance(
            rebalance.id,
          );
          const messageExecution = executions.find(
            (e) => e.type === 'rebalance_message',
          );
          if (messageExecution) {
            this.tracker.updateExecutionStatus(messageExecution.id, 'failed');
          }
        }
      }
    }
  }

  /**
   * Check if a rebalance is ready to execute (all prerequisites complete).
   */
  private isRebalanceReady(rebalance: Rebalance): boolean {
    const executions = this.tracker.getExecutionsForRebalance(rebalance.id);

    // Find the rebalance_message execution
    const messageExecution = executions.find(
      (e) => e.type === 'rebalance_message',
    );
    if (!messageExecution || messageExecution.status !== 'not_started') {
      return false;
    }

    // Check if all prerequisite executions are complete
    const prerequisites = executions.filter(
      (e) => e.type !== 'rebalance_message',
    );
    return prerequisites.every((e) => e.status === 'complete');
  }

  /**
   * Cancel a rebalance by ID.
   */
  cancelRebalance(rebalanceId: string): boolean {
    return this.tracker.cancelRebalance(rebalanceId);
  }

  /**
   * Get summary of current state.
   */
  getStatus(): {
    pendingRebalances: number;
    pendingExecutions: number;
    executionsByType: Record<ExecutionType, number>;
  } {
    const pendingRebalances = this.tracker.getPendingRebalances();
    const pendingExecutions = this.tracker.getPendingExecutions();

    const executionsByType: Record<ExecutionType, number> = {
      rebalance_message: 0,
      inventory_movement: 0,
      inventory_deposit: 0,
    };

    for (const execution of pendingExecutions) {
      executionsByType[execution.type]++;
    }

    return {
      pendingRebalances: pendingRebalances.length,
      pendingExecutions: pendingExecutions.length,
      executionsByType,
    };
  }
}
