import type { MovableCollateralExecutionResult } from '../../interfaces/IRebalancer.js';
import type { MovableCollateralRoute } from '../../interfaces/IStrategy.js';

export type MovableInternalExecutionResult =
  MovableCollateralExecutionResult & {
    intentId: string;
    canonicalAmount?: bigint;
    localAmount?: bigint;
  };

export type MovableInternalRoute = MovableCollateralRoute & {
  intentId: string;
};
