import type { ChainName } from '@hyperlane-xyz/sdk';

/**
 * Status of a logical rebalance operation
 */
export type RebalanceStatus =
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'cancelled';

/**
 * Type of execution action
 */
export type ExecutionType =
  | 'rebalance_message' // Hyperlane transferRemote to move collateral
  | 'inventory_movement' // External bridge (LiFi) to move inventory
  | 'inventory_deposit'; // Deposit inventory as collateral

/**
 * Status of an individual execution
 */
export type ExecutionStatus =
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'failed';

/**
 * A logical rebalance operation.
 *
 * This represents the intent to move collateral from one chain to another.
 * It may require multiple executions to complete (e.g., move inventory first,
 * then transferRemote).
 */
export type Rebalance = {
  /** Unique identifier for this rebalance */
  id: string;
  /** Chain to move collateral from */
  origin: ChainName;
  /** Chain to move collateral to */
  destination: ChainName;
  /** Amount to rebalance (in wei) */
  amount: bigint;
  /** Current status */
  status: RebalanceStatus;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp when last updated */
  updatedAt: number;
};

/**
 * An individual execution action that is part of a rebalance.
 *
 * A rebalance may have multiple executions:
 * 1. inventory_movement - Move inventory to the source chain via LiFi
 * 2. rebalance_message - Call transferRemote to move collateral
 */
export type Execution = {
  /** Unique identifier for this execution */
  id: string;
  /** Reference to the parent rebalance */
  rebalanceId: string;
  /** Hyperlane message ID (for rebalance_message type) */
  messageId?: string;
  /** External transaction hash (for inventory_movement type) */
  txHash?: string;
  /** Type of execution */
  type: ExecutionType;
  /** Current status */
  status: ExecutionStatus;
  /** Chain where execution originates */
  origin: ChainName;
  /** Chain where execution completes */
  destination: ChainName;
  /** Amount being moved */
  amount: bigint;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp when last updated */
  updatedAt: number;
};

/**
 * Input for creating a new rebalance
 */
export type CreateRebalanceInput = {
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
};

/**
 * Input for creating a new execution
 */
export type CreateExecutionInput = {
  rebalanceId: string;
  type: ExecutionType;
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
};

/**
 * Context provided to strategies about in-progress operations.
 * This allows strategies to make informed decisions about new rebalances.
 */
export type RebalanceContext = {
  /** Rebalances that are currently in progress */
  pendingRebalances: Rebalance[];
  /** Executions that are currently in progress */
  pendingExecutions: Execution[];
};
