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
}

export interface RebalanceAction extends TrackedActionBase {
  status: RebalanceActionStatus;
  intentId: string; // Links to parent RebalanceIntent
  messageId: string; // Hyperlane message ID
  txHash?: string; // Origin transaction hash
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
