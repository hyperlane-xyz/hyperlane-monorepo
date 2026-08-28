import {
  type EvmMovableCollateralAdapter,
  type IToken,
  type TokenAmount,
} from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import {
  type InventoryRoute,
  type MovableCollateralRoute,
  type Route,
} from './IStrategy.js';
import type { MCRStatusRef } from './ITokenBridgeStatusAdapter.js';

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
  externalExecutionRef?: MCRStatusRef;
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

type PreparedOriginTokenAmount = TokenAmount<IToken>;

export type PreparedTransaction = {
  populatedTx: Awaited<
    ReturnType<EvmMovableCollateralAdapter['populateRebalanceTx']>
  >;
  route: MovableCollateralRoute & { intentId: string };
  originTokenAmount: PreparedOriginTokenAmount;
  /** Collateral-denominated bridge fee excess pulled from the rebalancer. */
  collateralFeeApproval?: {
    token: Address;
    spender: Address;
    amount: bigint;
  };
};
