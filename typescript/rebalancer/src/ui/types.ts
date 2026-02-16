import type {
  RebalanceActionStatus,
  RebalanceIntentStatus,
  TransferStatus,
} from '../tracking/types.js';
import type { ActionType, ExecutionMethod } from '../tracking/types.js';

/**
 * UI-ready balance data with weight calculations.
 */
export interface UIBalanceData {
  chain: string; // Chain name
  routerCollateral: string; // bigint as string
  inventory: string; // bigint as string
  targetWeight: number | null; // null when strategy is not weighted
  currentWeight: number; // 0-100, proportion of total
  deviation: number | null; // null when targetWeight is null
}

/**
 * UI-ready transfer with chain name enrichment.
 */
export interface UITransfer {
  id: string;
  status: TransferStatus;
  origin: number; // Domain ID
  destination: number; // Domain ID
  originChainName: string; // Resolved chain name
  destinationChainName: string;
  amount: string; // bigint as string
  messageId: string;
  sender: string;
  recipient: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * UI-ready rebalance intent with chain name enrichment.
 */
export interface UIIntent {
  id: string;
  status: RebalanceIntentStatus;
  origin: number; // Domain ID
  destination: number; // Domain ID
  originChainName: string; // Resolved chain name
  destinationChainName: string;
  amount: string; // bigint as string
  executionMethod?: ExecutionMethod;
  bridge?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * UI-ready rebalance action with chain name enrichment.
 */
export interface UIAction {
  id: string;
  status: RebalanceActionStatus;
  type: ActionType;
  origin: number; // Domain ID
  destination: number; // Domain ID
  originChainName: string; // Resolved chain name
  destinationChainName: string;
  amount: string; // bigint as string
  intentId: string;
  txHash: string | null;
  bridgeTransferId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Complete dashboard state.
 */
export interface DashboardState {
  balances: UIBalanceData[];
  transfers: UITransfer[];
  intents: UIIntent[];
  actions: UIAction[];
}

/**
 * WebSocket message type for full state updates.
 */
export type WebSocketMessage = {
  type: 'full_state';
  data: DashboardState;
};
