import { RebalancingRoute } from './IStrategy.js';

export interface IExecutor {
  rebalance(routes: RebalancingRoute[]): Promise<void>;
}
