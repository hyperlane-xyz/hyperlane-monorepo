import { RebalancingRoute } from './IStrategy.js';

export interface IRebalancer {
  rebalance(routes: RebalancingRoute[]): Promise<void>;
}
