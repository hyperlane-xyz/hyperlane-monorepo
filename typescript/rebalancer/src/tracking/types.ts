import type { Address, Domain } from '@hyperlane-xyz/utils';

import type { IStore } from './store/IStore.js';

// === Base Interfaces ===

export interface Identifiable {
  id: string;
}

export interface CrossChainAction {
  origin: Domain;
  destination: Domain;
  amount: bigint;
}

export interface Timestamped {
  createdAt: number;
  updatedAt: number;
}

export interface TrackedActionBase
  extends Identifiable,
    CrossChainAction,
    Timestamped {
  status: string;
}

// === Status Types ===

export type TransferStatus = 'in_progress' | 'complete';
export type RebalanceIntentStatus =
  | 'not_started'
  | 'in_progress'
  | 'complete'
  | 'cancelled'
  | 'failed';
export type RebalanceActionStatus = 'in_progress' | 'complete' | 'failed';

// === Execution Types ===

/**
 * Execution method for rebalancing:
 * - `movable_collateral`: Uses MovableCollateralRouter.rebalance() on-chain
 * - `inventory`: Uses external bridges (LiFi) + transferRemote
 */
export type ExecutionMethod = 'movable_collateral' | 'inventory';

/**
 * Type of rebalance action:
 * - `rebalance_message`: Standard movable collateral rebalance (Hyperlane message)
 * - `inventory_movement`: External bridge transfer (e.g., LiFi) to move inventory
 * - `inventory_deposit`: transferRemote to deposit inventory as collateral
 */
export type ActionType =
  | 'rebalance_message'
  | 'inventory_movement'
  | 'inventory_deposit';

// === Entity Types ===

export interface Transfer extends TrackedActionBase {
  status: TransferStatus;
  messageId: string;
  sender: Address;
  recipient: Address;
}

export interface RebalanceIntent extends TrackedActionBase {
  status: RebalanceIntentStatus;
  fulfilledAmount: bigint;
  bridge?: Address; // Optional - bridge contract used (missing for recovered intents)
  priority?: number; // Optional - missing for recovered intents
  strategyType?: string; // Optional - missing for recovered intents
  executionMethod?: ExecutionMethod; // Optional - defaults to movable_collateral
  originalDeficit?: bigint; // Optional - original deficit for re-evaluation (inventory only)
}

export interface RebalanceAction extends TrackedActionBase {
  status: RebalanceActionStatus;
  type: ActionType; // Type of action (rebalance_message, inventory_movement, inventory_deposit)
  intentId: string; // Links to parent RebalanceIntent
  messageId?: string; // Hyperlane message ID (required for rebalance_message, inventory_deposit)
  txHash?: string; // Origin transaction hash
  // Fields for inventory_movement (external bridge)
  bridgeTransferId?: string; // External bridge transfer ID (e.g., LiFi transfer ID)
  bridgeId?: string; // External bridge identifier (e.g., 'lifi')
}

// === Type Aliases for Stores ===

export type ITransferStore = IStore<Transfer, TransferStatus>;
export type IRebalanceIntentStore = IStore<
  RebalanceIntent,
  RebalanceIntentStatus
>;
export type IRebalanceActionStore = IStore<
  RebalanceAction,
  RebalanceActionStatus
>;
