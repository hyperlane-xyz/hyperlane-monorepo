import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import type { ChainName } from '@hyperlane-xyz/sdk';

import type {
  CreateExecutionInput,
  CreateRebalanceInput,
  Execution,
  ExecutionStatus,
  Rebalance,
  RebalanceContext,
  RebalanceStatus,
} from './types.js';

/**
 * RebalanceTracker manages the lifecycle of rebalances and their executions.
 *
 * It maintains in-memory collections of:
 * - Rebalances: logical operations to move collateral between chains
 * - Executions: individual actions that make up a rebalance
 *
 * This enables:
 * - Non-blocking multi-step rebalances (inventory movement → transferRemote)
 * - State persistence across rebalance cycles
 * - Duplicate detection and coordination
 */
export class RebalanceTracker {
  private readonly logger: Logger;

  /** In-memory store of rebalances by ID */
  private rebalances: Map<string, Rebalance> = new Map();

  /** In-memory store of executions by ID */
  private executions: Map<string, Execution> = new Map();

  /** Index of executions by rebalance ID for fast lookup */
  private executionsByRebalance: Map<string, Set<string>> = new Map();

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'RebalanceTracker' });
  }

  /**
   * Create a new rebalance operation.
   * Returns null if a similar rebalance already exists and is in progress.
   */
  createRebalance(input: CreateRebalanceInput): Rebalance | null {
    // Check for existing in-progress rebalance to same destination
    const existing = this.findPendingRebalance(input.origin, input.destination);
    if (existing) {
      this.logger.debug(
        {
          existingId: existing.id,
          origin: input.origin,
          destination: input.destination,
        },
        'Rebalance already in progress, skipping',
      );
      return null;
    }

    const now = Date.now();
    const rebalance: Rebalance = {
      id: uuidv4(),
      origin: input.origin,
      destination: input.destination,
      amount: input.amount,
      status: 'not_started',
      createdAt: now,
      updatedAt: now,
    };

    this.rebalances.set(rebalance.id, rebalance);
    this.executionsByRebalance.set(rebalance.id, new Set());

    this.logger.info(
      {
        id: rebalance.id,
        origin: rebalance.origin,
        destination: rebalance.destination,
        amount: rebalance.amount.toString(),
      },
      'Created new rebalance',
    );

    return rebalance;
  }

  /**
   * Find a pending rebalance for the given origin/destination pair.
   */
  findPendingRebalance(
    origin: ChainName,
    destination: ChainName,
  ): Rebalance | undefined {
    for (const rebalance of this.rebalances.values()) {
      if (
        rebalance.origin === origin &&
        rebalance.destination === destination &&
        (rebalance.status === 'not_started' ||
          rebalance.status === 'in_progress')
      ) {
        return rebalance;
      }
    }
    return undefined;
  }

  /**
   * Get a rebalance by ID.
   */
  getRebalance(id: string): Rebalance | undefined {
    return this.rebalances.get(id);
  }

  /**
   * Update the status of a rebalance.
   */
  updateRebalanceStatus(id: string, status: RebalanceStatus): void {
    const rebalance = this.rebalances.get(id);
    if (!rebalance) {
      this.logger.warn({ id }, 'Attempted to update non-existent rebalance');
      return;
    }

    const oldStatus = rebalance.status;
    rebalance.status = status;
    rebalance.updatedAt = Date.now();

    this.logger.info(
      { id, oldStatus, newStatus: status },
      'Updated rebalance status',
    );
  }

  /**
   * Cancel a rebalance if it hasn't started execution yet.
   * Returns true if cancelled, false if it couldn't be cancelled.
   */
  cancelRebalance(id: string): boolean {
    const rebalance = this.rebalances.get(id);
    if (!rebalance) {
      return false;
    }

    // Can only cancel if not started or if all executions can be cancelled
    if (rebalance.status === 'complete') {
      this.logger.warn({ id }, 'Cannot cancel completed rebalance');
      return false;
    }

    // Check if any executions are in progress
    const executions = this.getExecutionsForRebalance(id);
    const hasInProgressExecution = executions.some(
      (e) => e.status === 'in_progress',
    );

    if (hasInProgressExecution) {
      this.logger.warn(
        { id },
        'Cannot cancel rebalance with in-progress executions',
      );
      return false;
    }

    this.updateRebalanceStatus(id, 'cancelled');
    return true;
  }

  /**
   * Create a new execution for a rebalance.
   */
  createExecution(input: CreateExecutionInput): Execution {
    const rebalance = this.rebalances.get(input.rebalanceId);
    if (!rebalance) {
      throw new Error(`Rebalance ${input.rebalanceId} not found`);
    }

    const now = Date.now();
    const execution: Execution = {
      id: uuidv4(),
      rebalanceId: input.rebalanceId,
      type: input.type,
      status: 'not_started',
      origin: input.origin,
      destination: input.destination,
      amount: input.amount,
      createdAt: now,
      updatedAt: now,
    };

    this.executions.set(execution.id, execution);
    this.executionsByRebalance.get(input.rebalanceId)?.add(execution.id);

    // Mark rebalance as in progress when first execution is created
    if (rebalance.status === 'not_started') {
      this.updateRebalanceStatus(input.rebalanceId, 'in_progress');
    }

    this.logger.info(
      {
        id: execution.id,
        rebalanceId: input.rebalanceId,
        type: execution.type,
        origin: execution.origin,
        destination: execution.destination,
        amount: execution.amount.toString(),
      },
      'Created new execution',
    );

    return execution;
  }

  /**
   * Get an execution by ID.
   */
  getExecution(id: string): Execution | undefined {
    return this.executions.get(id);
  }

  /**
   * Get all executions for a rebalance.
   */
  getExecutionsForRebalance(rebalanceId: string): Execution[] {
    const executionIds = this.executionsByRebalance.get(rebalanceId);
    if (!executionIds) {
      return [];
    }

    return Array.from(executionIds)
      .map((id) => this.executions.get(id))
      .filter((e): e is Execution => e !== undefined);
  }

  /**
   * Update the status of an execution.
   */
  updateExecutionStatus(id: string, status: ExecutionStatus): void {
    const execution = this.executions.get(id);
    if (!execution) {
      this.logger.warn({ id }, 'Attempted to update non-existent execution');
      return;
    }

    const oldStatus = execution.status;
    execution.status = status;
    execution.updatedAt = Date.now();

    this.logger.info(
      { id, oldStatus, newStatus: status },
      'Updated execution status',
    );

    // Check if rebalance should be marked complete
    if (status === 'complete') {
      this.checkRebalanceCompletion(execution.rebalanceId);
    }
  }

  /**
   * Set the message ID for a rebalance_message execution.
   */
  setExecutionMessageId(id: string, messageId: string): void {
    const execution = this.executions.get(id);
    if (!execution) {
      return;
    }

    execution.messageId = messageId;
    execution.updatedAt = Date.now();

    this.logger.debug({ id, messageId }, 'Set execution message ID');
  }

  /**
   * Set the transaction hash for an inventory_movement execution.
   */
  setExecutionTxHash(id: string, txHash: string): void {
    const execution = this.executions.get(id);
    if (!execution) {
      return;
    }

    execution.txHash = txHash;
    execution.updatedAt = Date.now();

    this.logger.debug({ id, txHash }, 'Set execution tx hash');
  }

  /**
   * Check if all executions for a rebalance are complete and update status.
   */
  private checkRebalanceCompletion(rebalanceId: string): void {
    const executions = this.getExecutionsForRebalance(rebalanceId);

    if (executions.length === 0) {
      return;
    }

    const allComplete = executions.every((e) => e.status === 'complete');
    const anyFailed = executions.some((e) => e.status === 'failed');

    if (allComplete) {
      this.updateRebalanceStatus(rebalanceId, 'complete');
    } else if (anyFailed) {
      // If any execution failed, we might want to handle this differently
      this.logger.warn({ rebalanceId }, 'Rebalance has failed execution(s)');
    }
  }

  /**
   * Get all pending (not_started or in_progress) rebalances.
   */
  getPendingRebalances(): Rebalance[] {
    return Array.from(this.rebalances.values()).filter(
      (r) => r.status === 'not_started' || r.status === 'in_progress',
    );
  }

  /**
   * Get all pending (not_started or in_progress) executions.
   */
  getPendingExecutions(): Execution[] {
    return Array.from(this.executions.values()).filter(
      (e) => e.status === 'not_started' || e.status === 'in_progress',
    );
  }

  /**
   * Get the context for strategies to use when making decisions.
   */
  getRebalanceContext(): RebalanceContext {
    return {
      pendingRebalances: this.getPendingRebalances(),
      pendingExecutions: this.getPendingExecutions(),
    };
  }

  /**
   * Clean up old completed/cancelled rebalances and their executions.
   * @param maxAge Maximum age in milliseconds to keep
   */
  cleanup(maxAge: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, rebalance] of this.rebalances) {
      if (
        (rebalance.status === 'complete' || rebalance.status === 'cancelled') &&
        now - rebalance.updatedAt > maxAge
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      // Delete associated executions
      const executionIds = this.executionsByRebalance.get(id);
      if (executionIds) {
        for (const execId of executionIds) {
          this.executions.delete(execId);
        }
      }
      this.executionsByRebalance.delete(id);
      this.rebalances.delete(id);
    }

    if (toDelete.length > 0) {
      this.logger.info({ count: toDelete.length }, 'Cleaned up old rebalances');
    }
  }
}
