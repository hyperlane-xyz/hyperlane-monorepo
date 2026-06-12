import {
  type ChainMap,
  type EvmMovableCollateralAdapter,
  type IToken,
  type TokenAmount,
} from '@hyperlane-xyz/sdk';

import type { ConfirmedBlockTags } from './IMonitor.js';
import {
  type InventoryRoute,
  type MovableCollateralRoute,
  type RawBalances,
  type Route,
} from './IStrategy.js';

export type RebalancerType = 'movableCollateral' | 'inventory';
export type ExecutionStatus = 'success' | 'partial' | 'failed';

export interface RebalanceCycleContext {
  balances: RawBalances;
  inventoryBalances?: ChainMap<bigint>;
  confirmedBlockTags?: ConfirmedBlockTags;
}

export interface ExecutionResult<R extends Route = Route> {
  route: R;
  success: boolean;
  error?: string;
  // messageId?: string;
  txHash?: string;
  // amountSent?: bigint;
  reason?: string;
}

export interface MovableCollateralExecutionResult extends ExecutionResult<MovableCollateralRoute> {
  messageId: string;
}

export interface InventoryExecutionResult extends ExecutionResult<InventoryRoute> {
  messageId?: string;
  amountSent?: bigint;
}

export interface ExecutionSummary<
  R extends Route = Route,
  E extends ExecutionResult<R> = ExecutionResult<R>,
> {
  status: ExecutionStatus;
  results: E[];
  systemErrors: string[];
}

export interface IRebalancer<
  R extends Route = Route,
  E extends ExecutionResult<R> = ExecutionResult<R>,
> {
  readonly rebalancerType: RebalancerType;
  rebalance(routes: R[], context?: RebalanceCycleContext): Promise<E[]>;
}

export type IMovableCollateralRebalancer = IRebalancer<
  MovableCollateralRoute,
  MovableCollateralExecutionResult
>;

export type IInventoryRebalancer = IRebalancer<
  InventoryRoute,
  InventoryExecutionResult
>;

type PreparedOriginTokenAmount = TokenAmount<IToken>;

export type PreparedTransaction = {
  populatedTx: Awaited<
    ReturnType<EvmMovableCollateralAdapter['populateRebalanceTx']>
  >;
  route: MovableCollateralRoute & { intentId: string };
  originTokenAmount: PreparedOriginTokenAmount;
};
