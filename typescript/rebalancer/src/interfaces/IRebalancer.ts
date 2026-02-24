import {
  type EvmMovableCollateralAdapter,
  type TokenAmount,
} from '@hyperlane-xyz/sdk';

import {
  type InventoryRoute,
  type MovableCollateralRoute,
  type Route,
} from './IStrategy.js';

export type RebalancerType = 'movableCollateral' | 'inventory';

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

export interface IRebalancer<
  R extends Route = Route,
  E extends ExecutionResult<R> = ExecutionResult<R>,
> {
  readonly rebalancerType: RebalancerType;
  rebalance(routes: R[]): Promise<E[]>;
}

export type IMovableCollateralRebalancer = IRebalancer<
  MovableCollateralRoute,
  MovableCollateralExecutionResult
>;

export type IInventoryRebalancer = IRebalancer<
  InventoryRoute,
  InventoryExecutionResult
>;

export type PreparedTransaction = {
  populatedTx: Awaited<
    ReturnType<EvmMovableCollateralAdapter['populateRebalanceTx']>
  >;
  route: MovableCollateralRoute & { intentId: string };
  originTokenAmount: TokenAmount;
};
